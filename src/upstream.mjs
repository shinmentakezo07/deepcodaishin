import { MODEL_BASE, DEBUG_HEADERS, SEND_MACHINE_HEADER } from "./config.mjs";
import { fingerprintHeaders } from "./fingerprint.mjs";
import { nextAccount, accountCount, loadSettings } from "./account.mjs";
import { recordAccount } from "./metrics.mjs";

// ---------------------------------------------------------------- upstream

/**
 * The gateway rejects anything that is not shaped like the desktop client: every
 * request is streamed, carries stream_options.include_usage, and goes through the
 * api-key + lane/machine headers.
 *
 * Key order is normalised to the order pi emits (model, messages, stream,
 * prompt_cache_key, stream_options, then the rest) so the payload is
 * field-for-field what the app sends.
 */
function upstreamPayload(payload) {
  const { model, messages, prompt_cache_key, stream, stream_options, ...rest } = payload;
  const out = { model, messages, stream: true };
  if (prompt_cache_key !== undefined) out.prompt_cache_key = prompt_cache_key;
  out.stream_options = { include_usage: true };
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Given an upstream error response, try to extract a friendly message. */
function upstreamErrorMessage(status, body, accountName) {
  const who = accountName ? " (account " + accountName + ")" : "";
  if (status === 400 && body.includes("DeepAI Code sends")) {
    return "Gateway rejected the request shape" + who + ". Check stream:true + " +
      "stream_options.include_usage, and that the account machineId is not a rejected value.";
  }
  return "Upstream error " + status + who + ": " + body.slice(0, 200);
}

function debugBody(obj) {
  const body = JSON.stringify(obj);
  if (process.env.DEBUG) console.error("UPSTREAM " + body);
  return body;
}

/** Prints the outgoing header set with the credential masked. */
function logHeaders(headers) {
  if (!DEBUG_HEADERS) return;
  const safe = { ...headers };
  if (safe["api-key"]) safe["api-key"] = "<redacted len " + String(safe["api-key"]).length + ">";
  console.error("UPSTREAM HEADERS " + JSON.stringify(safe));
  console.error("UPSTREAM URL " + MODEL_BASE + "/chat/completions");
}

function isRetryable(status) {
  return status === 401 || status === 403 || status === 429;
}

/** The store setting wins only when the env var has not already forced it on. */
function sendMachine() {
  if (SEND_MACHINE_HEADER) return true;
  try {
    return loadSettings().sendMachineHeader === true;
  } catch {
    return false;
  }
}

function postOnce(account, body, affinity, signal) {
  const headers = fingerprintHeaders(account, { "X-Session-Affinity": affinity }, { machine: sendMachine() });
  logHeaders(headers);
  return fetch(MODEL_BASE + "/chat/completions", {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal,
    duplex: "half",
  });
}

/**
 * Send one upstream request.
 *
 * With an explicit account the request is pinned to it. Otherwise the next
 * account in the rotation is used, and a rejected account (401/403/429) or a
 * network failure moves on to the next one, up to one attempt per account.
 */
async function upstreamFetch(payload, { affinity, signal, account } = {}) {
  const total = accountCount();
  if (total === 0) throw Object.assign(new Error("not signed in"), { status: 401 });

  const body = debugBody(upstreamPayload(payload));

  if (account) {
    recordAccount(account.name || "account");
    return postOnce(account, body, affinity, signal);
  }

  let res = null;
  for (let attempt = 0; attempt < total; attempt += 1) {
    const acc = nextAccount();
    if (!acc) break;
    recordAccount(acc.name || "account " + (acc.index + 1));
    try {
      res = await postOnce(acc, body, affinity, signal);
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) throw err;
      res = null;
      continue;
    }
    if (!isRetryable(res.status)) return res;
    if (attempt < total - 1) {
      try {
        await res.body.cancel();
      } catch {}
    }
  }

  if (!res) throw Object.assign(new Error("all accounts failed"), { status: 502 });
  return res;
}

export { upstreamPayload, upstreamFetch, upstreamErrorMessage, logHeaders };
