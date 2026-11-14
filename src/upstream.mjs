import { MODEL_BASE, DEBUG_HEADERS, SEND_MACHINE_HEADER } from "./config.mjs";
import { fingerprintHeaders } from "./fingerprint.mjs";
import { ensureLaneSoon, isLaneRejection, noteLaneRejected, refreshLane } from "./lane.mjs";
import {
  nextAccountSequence,
  accountCount,
  loadSettings,
  markAccountRejected,
  markAccountHealthy,
} from "./account.mjs";
import { recordAccount, recordRejection } from "./metrics.mjs";

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
  if (status === 426 && body.includes("lane_version_unsupported")) {
    return "Gateway retired this lane" + who + " - the proxy re-discovers the lane automatically; " +
      "retry, or run \"node deepai-proxy.mjs lane\" to see the served version.";
  }
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
 * Send a request, surviving a lane bump without a restart.
 *
 * When the gateway retires the lane mid-run it answers 426
 * lane_version_unsupported. The cached lane is dropped, the served lane is
 * discovered again, and the same request is replayed once (twice at most) with
 * the new header. Anything else is returned untouched.
 */
async function postWithLaneRetry(account, body, affinity, signal) {
  let res = await postOnce(account, body, affinity, signal);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await isLaneRejection(res))) return res;
    noteLaneRejected();
    try {
      await res.body?.cancel();
    } catch {}
    const info = await refreshLane({ force: true, signal });
    if (!info.autoDiscover) return res;
    res = await postOnce(account, body, affinity, signal);
  }
  return res;
}

/**
 * Send one upstream request.
 *
 * With an explicit account the request is pinned to it. Otherwise the next
 * account in the rotation is used, and a rejected account (401/403/429) or a
 * network failure moves on to the next one, up to one attempt per account.
 */
async function upstreamFetch(payload, { affinity, signal, account } = {}) {
  if (accountCount() === 0) throw Object.assign(new Error("not signed in"), { status: 401 });

  // Refresh the discovered lane in the background when it is getting old; the
  // 426 retry below covers the case where it is already stale.
  ensureLaneSoon();

  const body = debugBody(upstreamPayload(payload));

  if (account) {
    recordAccount(account);
    const pinned = await postWithLaneRetry(account, body, affinity, signal);
    pinned.account = account;
    if (pinned.ok) markAccountHealthy(account);
    return pinned;
  }

  // The sequence is the rotation from the current slot onwards. Exactly one slot
  // is consumed per request; failover only walks forward inside that sequence.
  const candidates = nextAccountSequence();
  let res = null;

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const acc = candidates[attempt];
    recordAccount(acc);
    try {
      res = await postWithLaneRetry(acc, body, affinity, signal);
    } catch (err) {
      if (err && (err.name === "AbortError" || (signal && signal.aborted))) throw err;
      res = null;
      continue;
    }
    if (!isRetryable(res.status)) {
      res.account = acc;
      markAccountHealthy(acc);
      return res;
    }
    recordRejection(acc);
    markAccountRejected(acc);
    if (attempt < candidates.length - 1) {
      try {
        await res.body.cancel();
      } catch {}
    }
  }

  if (!res) throw Object.assign(new Error("all accounts failed"), { status: 502 });
  return res;
}

export { upstreamPayload, upstreamFetch, upstreamErrorMessage, logHeaders };
