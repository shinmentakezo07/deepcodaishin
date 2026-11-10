import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PORT, MODEL_BASE, PROXY_TOKEN, ACC_PATH, ROOT_DIR } from "./config.mjs";
import { handleApi } from "./api.mjs";
import { handleLoginCallback } from "./login.mjs";
import { MACHINE_HEADER } from "./fingerprint.mjs";
import {
  listAccountSummaries,
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
import { aggregateStream, tapStreamUsage } from "./stream-aggregate.mjs";
import { openAIToAnthropicStream } from "./anthropic-stream.mjs";
import { recordRequest, recordUsage, recordError } from "./metrics.mjs";

// ---------------------------------------------------------------- server

const UI_PATH = path.join(ROOT_DIR, "src", "ui.html");

function healthPayload() {
  const accounts = listAccountSummaries();
  const first = accounts[0];
  return {
    ok: true,
    signedIn: accounts.length > 0,
    username: first ? first.username : null,
    isPro: first ? first.isPro : null,
    accountCount: accounts.length,
    accountsRevision: accountsRevision(),
    settings: loadSettings(),
    rotation: rotationState(),
    machine: MACHINE_HEADER ? "present" : "absent",
    upstream: MODEL_BASE,
    ui: "http://127.0.0.1:" + PORT + "/",
  };
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    host === "0.0.0.0" || /^127\./.test(host);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
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
  if (origin && origin !== "null") {
    try {
      if (isLoopbackHost(new URL(origin).hostname)) res.setHeader("Access-Control-Allow-Origin", origin);
    } catch {}
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

async function serveUi(res) {
  try {
    const html = await fs.promises.readFile(UI_PATH, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch (err) {
    json(res, 500, errBody("UI not available: " + err.message));
  }
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

async function handleChatCompletions(req, res) {
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
  const up = await upstreamFetch(payload, { affinity });

  if (!up.ok) {
    recordError();
    const text = await up.text().catch(() => "");
    return json(res, up.status, {
      error: { message: upstreamErrorMessage(up.status, text), type: "upstream_error", code: `upstream_${up.status}` },
    });
  }

  if (!wantsStream) {
    const agg = await aggregateStream(up.body, payload.model);
    recordUsage(agg.usage, payload.model);
    return json(res, 200, agg);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  res.on("close", onClose);
  try {
    for await (const chunk of tapStreamUsage(up.body, (usage, model) => recordUsage(usage, model || payload.model))) {
      if (closed) break;
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

async function handleMessages(req, res) {
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

  const up = await upstreamFetch(upstreamReq, { affinity: req.headers["x-session-affinity"] });

  if (!up.ok) {
    recordError();
    const text = await up.text().catch(() => "");
    return json(res, up.status, errBody(upstreamErrorMessage(up.status, text), "upstream_error"));
  }

  if (!wantsStream) {
    const body = await aggregateStream(up.body, input.model);
    recordUsage(body.usage, input.model);
    return json(res, 200, openAIToAnthropic(body, input.model));
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  await openAIToAnthropicStream(up.body, input.model, res);
}

function handleCountTokens(req, res, raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
  }
  recordRequest("count_tokens");
  // Rough estimate: ~4 chars/token plus per-message overhead. No upstream call.
  const text = JSON.stringify(input.messages || "") + JSON.stringify(input.system || "");
  json(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
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
  const server = http.createServer(async (req, res) => {
    try {
        // request log: method and path only, never credentials
        console.log(`[HTTP] ${req.method} ${req.url}`);
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        return await serveUi(res);
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

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, url, healthPayload);
      }

      if (req.method !== "POST") return json(res, 404, errBody("not found", "not_found_error"));
      if (!authorized(req)) {
        return json(res, 401, errBody("invalid proxy token", "authentication_error"));
      }

      if (url.pathname === "/v1/chat/completions") return await handleChatCompletions(req, res);
      if (url.pathname === "/v1/messages") return await handleMessages(req, res);
      if (url.pathname === "/v1/messages/count_tokens") {
        return handleCountTokens(req, res, await readBody(req));
      }
      return json(res, 404, errBody("unsupported endpoint", "not_found_error"));
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, errBody(String(err?.message || err)));
      else res.end();
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`deepai-proxy listening on http://127.0.0.1:${PORT}`);
    console.log("  UI       : http://127.0.0.1:" + PORT + "/");
    console.log(`  OpenAI   : POST http://127.0.0.1:${PORT}/v1/chat/completions`);
    console.log(`  Anthropic: POST http://127.0.0.1:${PORT}/v1/messages`);
    console.log(`  upstream : ${MODEL_BASE}   machine header: ${MACHINE_HEADER ? "yes" : "no"}`);
  });
}

export { startServer };
