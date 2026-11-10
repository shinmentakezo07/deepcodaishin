import { MODEL_BASE } from "./config.mjs";
import { fingerprintHeaders } from "./fingerprint.mjs";
import { loadAccount } from "./account.mjs";

// ---------------------------------------------------------------- upstream

/**
 * The gateway rejects anything that is not shaped like the desktop client: every
 * request is streamed, carries `stream_options.include_usage`, and goes through
 * the `api-key` + lane/machine headers.
 */
function upstreamPayload(payload) {
  return { ...payload, stream: true, stream_options: { include_usage: true } };
}

/** Given an upstream error response, try to extract a friendly message. */
function upstreamErrorMessage(status, body) {
  // The gateway sometimes returns 400 "This request is not one DeepAI Code sends."
  if (status === 400 && body.includes("DeepAI Code sends"))
    return `Bad request – the gateway rejected the payload shape. Check: stream:true, stream_options.include_usage, and avoid X-DeepAI-Code-Machine unless DEEPAI_MACHINE_HEADER=1.`;
  return `Upstream error ${status}: ${body.slice(0, 200)}`;
}

function debugBody(obj) {
  const body = JSON.stringify(obj);
  if (process.env.DEBUG) console.error("UPSTREAM " + body);
  return body;
}

function upstreamFetch(payload, { affinity, signal }) {
  const acc = loadAccount();
  if (!acc) throw Object.assign(new Error("not signed in"), { status: 401 });
  return fetch(`${MODEL_BASE}/chat/completions`, {
    method: "POST",
    headers: fingerprintHeaders(acc.apiKey, { "X-Session-Affinity": affinity }),
    body: debugBody(upstreamPayload(payload)),
    redirect: "error",
    signal,
    duplex: "half",
  });
}

export { upstreamPayload, upstreamFetch, upstreamErrorMessage };
