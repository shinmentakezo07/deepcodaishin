import { MODEL_BASE } from "./config.mjs";
import { fingerprintHeaders } from "./fingerprint.mjs";
import { nextAccount, accountCount } from "./account.mjs";
import { recordAccount } from "./metrics.mjs";

// ---------------------------------------------------------------- upstream

/**
 * The gateway rejects anything that is not shaped like the desktop client: every
 * request is streamed, carries stream_options.include_usage, and goes through
 * the api-key + lane/machine headers.
 */
function upstreamPayload(payload) {
  return { ...payload, stream: true, stream_options: { include_usage: true } };
}

/** Given an upstream error response, try to extract a friendly message. */
function upstreamErrorMessage(status, body) {
  if (status === 400 && body.includes("DeepAI Code sends")) {
    return "Bad request - the gateway rejected the payload shape. Check: stream:true, " +
      "stream_options.include_usage, and avoid X-DeepAI-Code-Machine unless DEEPAI_MACHINE_HEADER=1.";
  }
  return "Upstream error " + status + ": " + body.slice(0, 200);
}

function debugBody(obj) {
  const body = JSON.stringify(obj);
  if (process.env.DEBUG) console.error("UPSTREAM " + body);
  return body;
}

function isRetryable(status) {
  return status === 401 || status === 403 || status === 429;
}

function postOnce(acc, body, affinity, signal) {
  return fetch(MODEL_BASE + "/chat/completions", {
    method: "POST",
    headers: fingerprintHeaders(acc.apiKey, { "X-Session-Affinity": affinity }),
    body,
    redirect: "error",
    signal,
    duplex: "half",
  });
}

/**
 * Send one upstream request using the next account in the round-robin. If the
 * chosen account is rejected (401/403/429) or the network call fails, try the
 * remaining accounts before giving up.
 */
async function upstreamFetch(payload, { affinity, signal } = {}) {
  const total = accountCount();
  if (total === 0) throw Object.assign(new Error("not signed in"), { status: 401 });

  const body = debugBody(upstreamPayload(payload));
  let res = null;

  for (let attempt = 0; attempt < total; attempt++) {
    const acc = nextAccount();
    if (!acc) break;
    recordAccount(acc.username || "account " + (acc.index + 1));
    try {
      res = await postOnce(acc, body, affinity, signal);
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) throw err;
      res = null;
      continue;
    }
    if (!isRetryable(res.status)) return res;
    // Keep the final error body; only discard responses we are about to retry.
    if (attempt < total - 1) {
      try {
        await res.body.cancel();
      } catch {}
    }
  }

  if (!res) throw Object.assign(new Error("all accounts failed"), { status: 502 });
  return res;
}

export { upstreamPayload, upstreamFetch, upstreamErrorMessage };
