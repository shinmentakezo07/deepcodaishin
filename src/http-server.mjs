import http from "node:http";
import crypto from "node:crypto";
import { PORT, MODEL_BASE, PROXY_TOKEN, ACC_PATH } from "./config.mjs";
import { MACHINE_HEADER } from "./fingerprint.mjs";
import { loadAccount } from "./account.mjs";
import { catalogIds } from "./models.mjs";
import { upstreamFetch, upstreamErrorMessage } from "./upstream.mjs";
import { anthropicToOpenAI } from "./anthropic-to-openai.mjs";
import { openAIToAnthropic } from "./openai-to-anthropic.mjs";
import { aggregateStream } from "./stream-aggregate.mjs";
import { openAIToAnthropicStream } from "./anthropic-stream.mjs";

// ---------------------------------------------------------------- server

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

  // Upstream is always streamed; the client may still ask for a single JSON body.
  const wantsStream = payload.stream === true;
  const affinity = req.headers["x-session-affinity"] || payload.prompt_cache_key || undefined;
  const up = await upstreamFetch(payload, { affinity });

  if (!up.ok) {
    const text = await up.text().catch(() => "");
    return json(res, up.status, {
      error: { message: upstreamErrorMessage(up.status, text), type: "upstream_error", code: `upstream_${up.status}` },
    });
  }

  if (!wantsStream) {
    const agg = await aggregateStream(up.body, payload.model);
    return json(res, 200, agg);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for await (const chunk of up.body) {
    if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
  }
  res.end();
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

  const wantsStream = input.stream === true;
  const upstreamReq = anthropicToOpenAI(input);

  const up = await upstreamFetch(upstreamReq, { affinity: req.headers["x-session-affinity"] });

  if (!up.ok) {
    const text = await up.text().catch(() => "");
    return json(res, up.status, errBody(upstreamErrorMessage(up.status, text), "upstream_error"));
  }

  if (!wantsStream) {
    const body = await aggregateStream(up.body, input.model);
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
  // Rough estimate: ~4 chars/token plus per-message overhead. No upstream call.
  const text = JSON.stringify(input.messages || "") + JSON.stringify(input.system || "");
  json(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
}

function startServer() {
  const acc = loadAccount();
  if (!acc) {
    console.error(`warning: no credential at ${ACC_PATH} yet — run "login" or "import-app"`);
  }
  const server = http.createServer(async (req, res) => {
    try {
        // request log
        const start = Date.now();
        console.log(`[HTTP] ${req.method} ${req.url}`);
        console.log(`[HTTP] headers: ${JSON.stringify(req.headers).slice(0, 200)}`);
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        const a = loadAccount();
        return json(res, 200, {
          ok: true,
          signedIn: !!a,
          username: a?.username || null,
          isPro: a?.isPro ?? null,
          machine: MACHINE_HEADER ? "present" : "absent",
          upstream: MODEL_BASE,
        });
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

      if (req.method !== "POST") return json(res, 404, errBody("not found", "not_found_error"));

      // Mirror the app: browser-origin requests are refused.
      if (req.headers.origin) {
        return json(res, 403, errBody("model transport authentication required", "permission_error"));
      }
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
    console.log(`  OpenAI   : POST http://127.0.0.1:${PORT}/v1/chat/completions`);
    console.log(`  Anthropic: POST http://127.0.0.1:${PORT}/v1/messages`);
    console.log(`  upstream : ${MODEL_BASE}   machine header: ${MACHINE_HEADER ? "yes" : "no"}`);
  });
}

export { startServer };
