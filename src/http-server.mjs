import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HOST,
  PORT,
  MODEL_BASE,
  PROXY_TOKEN,
  ACC_PATH,
  ROOT_DIR,
  ACCOUNT_NAME,
  LOG_REQUESTS,
  SEND_MACHINE_HEADER,
  EXTRA_ORIGINS,
} from "./config.mjs";
import { handleApi } from "./api.mjs";
import { handleLoginCallback } from "./login.mjs";
import { MACHINE_HEADER, MACHINE_SOURCE } from "./fingerprint.mjs";
import { laneInfo, warm } from "./lane.mjs";
import {
  listAccounts,
  listAccountSummaries,
  findAccount,
  accountMachineId,
  accountCount,
  accountsRevision,
  rotationState,
  loadSettings,
  captureAppAccounts,
} from "./account.mjs";
import { catalogIds } from "./models.mjs";
import { upstreamFetch, upstreamErrorMessage } from "./upstream.mjs";
import { anthropicToOpenAI } from "./anthropic-to-openai.mjs";
import { openAIToAnthropic } from "./openai-to-anthropic.mjs";
import { aggregateStream } from "./stream-aggregate.mjs";
import { relayGuarded } from "./stream-guard.mjs";
import { openAIToAnthropicStream } from "./anthropic-stream.mjs";
import { recordRequest, recordUsage, recordError } from "./metrics.mjs";

// ---------------------------------------------------------------- server

const UI_PATH = path.join(ROOT_DIR, "src", "ui.html");

function healthPayload() {
  const accounts = listAccounts();
  const active = accounts.find((a) => a.active) || accounts[0];
  return {
    ok: true,
    signedIn: accounts.length > 0,
    username: active ? active.username : null,
    isPro: active ? active.isPro : null,
    activeAccount: active ? active.name : null,
    accountCount: accounts.length,
    accountsRevision: accountsRevision(),
    settings: loadSettings(),
    rotation: rotationState(),
    accounts: accounts.map((a) => ({
      name: a.name,
      username: a.username,
      isPro: a.isPro,
      weight: a.weight,
      active: a.active,
      machine: accountMachineId(a, MACHINE_HEADER).slice(0, 12) + "...",
    })),
    lane: laneInfo(),
    machine: MACHINE_HEADER ? "present (" + MACHINE_SOURCE + ")" : "absent",
    sendMachineHeader: SEND_MACHINE_HEADER || loadSettings().sendMachineHeader === true,
    upstream: MODEL_BASE,
    ui: "http://127.0.0.1:" + PORT + "/",
  };
}

/**
 * Which account serves this request:
 *   ?account=<name>  >  x-proxy-account header  >  ACCOUNT env  >  rotation
 * Returns null when the caller did not ask for a specific account.
 */
function pickAccount(req, url) {
  const name =
    url.searchParams.get("account") ||
    (typeof req.headers["x-proxy-account"] === "string" ? req.headers["x-proxy-account"] : "") ||
    ACCOUNT_NAME ||
    "";
  if (!name) return null;
  const account = findAccount(name);
  if (!account) {
    throw Object.assign(new Error('unknown account "' + name + '"'), { status: 404 });
  }
  return account;
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    host === "0.0.0.0" || /^127\./.test(host);
}

/** The host this request was addressed to, honouring a reverse proxy. */
function requestHost(req) {
  const raw = req.headers["x-forwarded-host"] || req.headers.host || "";
  return String(raw).split(",")[0].trim().toLowerCase();
}

/**
 * Same-origin is always allowed.
 *
 * The panel is served by this process, so a request whose Origin matches the
 * Host it arrived on is the panel talking to itself. That covers localhost,
 * a LAN address, and a platform hostname such as *.up.railway.app behind TLS
 * termination. Cross-origin requests are still refused, which is what keeps a
 * random web page from spending the account's credits.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (isLoopbackHost(parsed.hostname)) return true;

  const self = requestHost(req);
  if (self && parsed.host.toLowerCase() === self) return true;

  if (EXTRA_ORIGINS.has(parsed.origin.toLowerCase())) return true;
  return false;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

// Allow a local UI served from any loopback host/port to read responses.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== "null" && originAllowed(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

const UI_DIST = path.join(ROOT_DIR, "ui", "dist");
const UI_DIST_INDEX = path.join(UI_DIST, "index.html");

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the panel. A built React bundle (ui/dist) wins when it exists; the
 * single-file panel in src/ui.html is the fallback, so a fresh clone without a
 * build step still gets a working UI.
 */
async function serveUi(res) {
  const built = await fs.promises.readFile(UI_DIST_INDEX).catch(() => null);
  if (built) {
    res.writeHead(200, { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(built);
  }
  const legacy = await fs.promises.readFile(UI_PATH).catch(() => null);
  if (!legacy) {
    return json(res, 500, errBody("UI not available: no ui/dist build and no src/ui.html"));
  }
  res.writeHead(200, { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-store" });
  res.end(legacy);
}

/** Static assets for the built panel, confined to ui/dist. */
async function serveAsset(res, pathname) {
  const rel = pathname.replace(/^\/+/, "");
  const target = path.resolve(UI_DIST, rel);
  if (target !== UI_DIST && !target.startsWith(UI_DIST + path.sep)) {
    return json(res, 403, errBody("forbidden", "permission_error"));
  }
  const body = await fs.promises.readFile(target).catch(() => null);
  if (!body) return json(res, 404, errBody("not found", "not_found_error"));
  const type = STATIC_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(target);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  res.end(body);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errBody(message, type = "api_error") {
  return { type: "error", error: { type, message } };
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!PROXY_TOKEN) return true;
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(PROXY_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAbortError(err, signal) {
  return (err && err.name === "AbortError") || (signal && signal.aborted);
}

/** Resolve when the socket drains, or straight away if the peer went away. */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * Abort the upstream call when the caller hangs up.
 *
 * Without this a cancelled stream keeps consuming the account's Theos to the
 * last token, and a cancelled non-stream request keeps the upstream body open
 * for a response nobody will read.
 */
function clientAbort(res) {
  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ac.abort();
  };
  res.on("close", onClose);
  return { signal: ac.signal, dispose: () => res.off("close", onClose) };
}

/** Open an SSE response: headers now, token-sized frames without Nagle delay. */
function beginEventStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === "function") res.socket.setNoDelay(true);
}

async function handleChatCompletions(req, res, account) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
  }
  if (!payload?.model) {
    return json(res, 400, { error: { message: "missing model", type: "invalid_request_error" } });
  }

  recordRequest("chat");

  // Upstream is always streamed; the client may still ask for a single JSON body.
  const wantsStream = payload.stream === true;
  const affinity = req.headers["x-session-affinity"] || payload.prompt_cache_key || undefined;
  const abort = clientAbort(res);

  try {
    const up = await upstreamFetch(payload, { affinity, account, signal: abort.signal });

    if (!up.ok) {
      recordError(up.account);
      const text = await up.text().catch(() => "");
      return json(res, up.status, {
        error: {
          message: upstreamErrorMessage(up.status, text, account ? account.name : undefined),
          type: "upstream_error",
          code: "upstream_" + up.status,
        },
      });
    }

    if (!wantsStream) {
      const agg = await aggregateStream(up.body, payload.model);
      recordUsage(agg.usage, payload.model, up.account);
      return json(res, 200, agg);
    }

    beginEventStream(res);
    // Relay the stream unchanged except for a terminal upstream failure, which
    // is rewritten into a retryable 5xx so the client retries the turn instead
    // of abandoning it (see stream-guard.mjs).
    const relay = await relayGuarded(up.body, {
      write: async (chunk) => {
        if (res.destroyed || res.writableEnded) return false;
        if (!res.write(chunk)) await drained(res);
        return true;
      },
      onUsage: (usage, model) => recordUsage(usage, model || payload.model, up.account),
    });
    if (relay.error) recordError(up.account);
  } catch (err) {
    if (!isAbortError(err, abort.signal)) throw err;
  } finally {
    abort.dispose();
    if (res.headersSent && !res.writableEnded) res.end();
  }
}

async function handleMessages(req, res, account) {
  const raw = await readBody(req);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
  }
  if (!input?.model || !Array.isArray(input.messages)) {
    return json(res, 400, errBody("model and messages are required", "invalid_request_error"));
  }

  recordRequest("messages");

  const wantsStream = input.stream === true;
  const upstreamReq = anthropicToOpenAI(input);
  const abort = clientAbort(res);

  try {
    const up = await upstreamFetch(upstreamReq, {
      affinity: req.headers["x-session-affinity"],
      account,
      signal: abort.signal,
    });

    if (!up.ok) {
      recordError(up.account);
      const text = await up.text().catch(() => "");
      return json(
        res,
        up.status,
        errBody(upstreamErrorMessage(up.status, text, account ? account.name : undefined), "upstream_error"),
      );
    }

    if (!wantsStream) {
      const body = await aggregateStream(up.body, input.model);
      recordUsage(body.usage, input.model, up.account);
      return json(res, 200, openAIToAnthropic(body, input.model));
    }

    beginEventStream(res);
    await openAIToAnthropicStream(up.body, input.model, res, up.account);
  } catch (err) {
    if (!isAbortError(err, abort.signal)) throw err;
  } finally {
    abort.dispose();
    if (res.headersSent && !res.writableEnded) res.end();
  }
}

// CJK and other wide scripts are roughly one token per character, latin text
// roughly four characters per token.
const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/**
 * Approximate the input token count of an Anthropic request.
 *
 * There is no tokenizer here and no upstream call, so this walks the same
 * fields the request is translated from — system, message content blocks and
 * tool definitions — instead of stringifying the whole body. Stringifying
 * counted JSON punctuation, dropped tool schemas and counted base64 image data
 * as text, which is why a tools-heavy request used to be badly underestimated.
 */
function estimateInputTokens(input) {
  let chars = 0;
  let wide = 0;
  let messages = 0;

  const addText = (value) => {
    if (typeof value !== "string" || !value) return;
    const hits = value.match(WIDE_CHAR);
    if (hits) wide += hits.length;
    chars += value.length;
  };

  const addContent = (content) => {
    if (typeof content === "string") return addText(content);
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          addText(block.text);
          break;
        case "thinking":
          addText(block.thinking);
          break;
        case "image":
          chars += 1600; // a fixed per-image cost instead of counting base64
          break;
        case "document":
          chars += 800;
          break;
        case "tool_use":
          addText(block.name);
          if (block.input !== undefined) addText(JSON.stringify(block.input));
          break;
        case "tool_result":
          addContent(block.content);
          break;
        default:
          addText(block.text);
      }
    }
  };

  if (input && input.system) addContent(input.system);
  for (const message of Array.isArray(input && input.messages) ? input.messages : []) {
    messages += 1;
    addContent(message && message.content);
  }
  if (Array.isArray(input && input.tools)) {
    for (const tool of input.tools) {
      if (!tool || typeof tool !== "object") continue;
      addText(tool.name);
      addText(tool.description);
      if (tool.input_schema) addText(JSON.stringify(tool.input_schema));
    }
  }
  if (input && input.tool_choice) addText(JSON.stringify(input.tool_choice));

  const narrow = Math.max(0, chars - wide);
  // Per-message framing plus the request's own priming tokens.
  return Math.ceil(narrow / 4) + wide + messages * 4 + 3;
}

function handleCountTokens(req, res, raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
  }
  recordRequest("count_tokens");
  json(res, 200, { input_tokens: estimateInputTokens(input) });
}

function startServer() {
  if (accountCount() === 0) {
    // First run: pick up anything the desktop app already stored.
    try {
      const captured = captureAppAccounts();
      if (captured.added > 0) console.log(`auto-captured ${captured.added} credential(s) from the desktop app`);
    } catch {}
  }
  if (accountCount() === 0) {
    console.error(`warning: no credential at ${ACC_PATH} yet - run "login" or "import-app", or use the UI`);
  }
  // Learn the served lane (and the current app version for the check-in beacon)
  // before the first request. Non-blocking: a cold start must not wait on it.
  warm().catch(() => {});

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (LOG_REQUESTS) {
        // Never echo credentials: the proxy token and any client key arrive as headers.
        const safe = { ...req.headers };
        for (const k of ["authorization", "api-key", "x-api-key", "cookie"]) {
          if (safe[k]) safe[k] = "<redacted len " + String(safe[k]).length + ">";
        }
        console.log("[HTTP] " + req.method + " " + url.pathname + " " + JSON.stringify(safe));
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        return await serveUi(res);
      }

      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        return await serveAsset(res, url.pathname);
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, healthPayload());
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: catalogIds().map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "deepai",
          })),
        });
      }

      // Local UI can be served from any loopback host/port; refuse other origins.
      applyCors(req, res);
      if (!originAllowed(req)) {
        return json(res, 403, errBody("model transport authentication required", "permission_error"));
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/auth-callback") {
        const result = await handleLoginCallback(url);
        const title = result.ok ? "Signed in" : "Sign-in failed";
        const detail = result.ok ? "You can close this tab and return to the panel." : result.message;
        const body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" + escapeHtml(title) +
          "</title><style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e5e7eb;padding:40px;}" +
          "h2{color:" + (result.ok ? "#22c55e" : "#ef4444") + ";}a{color:#93c5fd}</style></head><body><h2>" +
          escapeHtml(title) + "</h2><p>" + escapeHtml(detail) + "</p><p><a href=\"/\">Back to panel</a></p></body></html>";
        res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(body);
      }

      // The panel API mutates the credential store and the rotation settings,
      // so it is guarded by the same token as the model endpoints. The origin
      // check alone cannot cover it: /health is public and carries the whole
      // account list, and originAllowed() trusts any loopback Origin.
      if (!authorized(req)) {
        return json(res, 401, errBody("invalid proxy token", "authentication_error"));
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, url, healthPayload);
      }

      if (req.method !== "POST") return json(res, 404, errBody("not found", "not_found_error"));

      if (url.pathname === "/v1/chat/completions") return await handleChatCompletions(req, res, pickAccount(req, url));
      if (url.pathname === "/v1/messages") return await handleMessages(req, res, pickAccount(req, url));
      if (url.pathname === "/v1/messages/count_tokens") {
        return handleCountTokens(req, res, await readBody(req));
      }
      return json(res, 404, errBody("unsupported endpoint", "not_found_error"));
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, errBody(String(err?.message || err)));
      else res.end();
    }
  });

  // Keep client sockets warm. Node closes an idle keep-alive connection after
  // 5s by default, which is shorter than the pause between turns in most chat
  // clients, so every turn would pay a fresh TCP handshake to the panel or the
  // SDK. headersTimeout must stay above keepAliveTimeout.
  server.keepAliveTimeout = Math.max(1000, Number(process.env.KEEPALIVE_TIMEOUT_MS || 65000));
  server.headersTimeout = server.keepAliveTimeout + 1000;

  server.listen(PORT, HOST, () => {
    console.log(`deepai-proxy listening on http://${HOST}:${PORT}`);
    console.log("  UI       : http://127.0.0.1:" + PORT + "/");
    console.log(`  OpenAI   : POST http://127.0.0.1:${PORT}/v1/chat/completions`);
    console.log(`  Anthropic: POST http://127.0.0.1:${PORT}/v1/messages`);
    const named = listAccounts();
    console.log("  accounts : " + (named.length ? named.map((a) => a.name).join(", ") : "(none)"));
    console.log("  active   : " + ((named.find((a) => a.active) || named[0] || {}).name || "-"));
    console.log(
      "  upstream : " + MODEL_BASE + "   machine header: " +
        (SEND_MACHINE_HEADER || loadSettings().sendMachineHeader ? "on (per account)" : "off") +
        "   local digest: " + (MACHINE_HEADER ? MACHINE_SOURCE : "unavailable"),
    );
  });
}

export { startServer };
