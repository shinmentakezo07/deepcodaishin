/**
 * Relay an upstream OpenAI SSE stream while watching for the two ways
 * api.deepai.org ends a turn early:
 *
 *   1. an in-band terminal frame, `data: {"error": {...}}`, sent after the
 *      vendor stream dies (the message we see in practice is
 *      "upstream stream interrupted"), and
 *   2. EOF with neither a `finish_reason` frame nor `data: [DONE]`.
 *
 * Both used to be relayed verbatim. An agent client classifies a failure from
 * the error text, and "upstream stream interrupted" matches none of the
 * retryable patterns its provider adapter knows, so the client treats the turn
 * as fatal instead of retrying it. Relaying the failure as `502 ...` makes
 * every OpenAI-compatible client classify it as a server error and retry.
 *
 * The hot path stays zero-copy: a chunk that cannot contain an error frame, a
 * finish frame, a usage frame or [DONE] is forwarded without parsing.
 */

const ERROR_MARK = '"error"';
// Every content frame carries "finish_reason":null, so only a non-null value
// (always a string) ends the turn. Matching the null form would treat the first
// token as terminal and hide a truncated stream.
const FINISH_MARK = /"finish_reason"\s*:\s*"/;
const USAGE_MARK = '"usage"';
const DONE_MARK = "[DONE]";
// A comment frame: every SSE client ignores it, and it keeps an idle proxy
// (Cloudflare, a load balancer) from closing a stream that is only "thinking".
const SSE_PING = ": ping\n\n";

export const STREAM_FAILURE_PREFIX = "502 upstream stream interrupted";

/**
 * Run `write` only when the stream has been quiet for `intervalMs`.
 *
 * A long reasoning pause produces no frames, and an idle timeout in front of
 * the container then kills a healthy stream. Call `touch()` on every forwarded
 * frame so an active stream is never interrupted by a keep-alive.
 */
export function keepAliveWhileQuiet(write, intervalMs = 15_000) {
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last < intervalMs) return;
    last = Date.now();
    void Promise.resolve().then(write).catch(() => {});
  }, Math.max(500, Math.floor(intervalMs / 2)));
  if (typeof timer.unref === "function") timer.unref();
  return {
    touch: () => {
      last = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * One message for a stream that died early, marked as a server error so an
 * OpenAI-compatible client retries it. Upstream text that already says what
 * happened is kept instead of being repeated.
 */
export function streamFailureMessage(detail) {
  const text = typeof detail === "string" && detail.trim() ? detail.trim() : "stream ended early";
  return /stream interrupted/i.test(text) ? "502 " + text : STREAM_FAILURE_PREFIX + ": " + text;
}

/** The data payload of one SSE frame, or null when the frame has none. */
function frameData(raw) {
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  return line ? line.slice(5).trim() : null;
}

/** True when `text` is one complete JSON value (a frame cut mid-write is not). */
function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forward `body` to `write`, replacing a terminal upstream failure with a
 * retryable one, and emit a keep-alive comment while the stream is quiet.
 *
 * @param body   upstream response body (async iterable of Uint8Array).
 * @param write  async (chunk: Uint8Array) => boolean; false stops the relay
 *               (the client hung up).
 * @param onUsage called for every frame that carries a usage block.
 * @param keepAliveMs quiet time before a comment frame; 0 disables it.
 * @returns {{ failed: boolean, stopped: boolean, error?: object }}
 */
export async function relayGuarded(body, options = {}) {
  const { write, keepAliveMs = 15_000 } = options;
  const beat = keepAliveMs > 0 ? keepAliveWhileQuiet(() => write(Buffer.from(SSE_PING)), keepAliveMs) : null;
  try {
    return await relayCore(body, options, beat);
  } finally {
    beat?.stop();
  }
}

async function relayCore(body, { write, onUsage }, beat) {
  const dec = new TextDecoder();
  let buf = "";
  let terminal = false;
  let failure = null;

  /** Forward one chunk and note that the stream is not idle. */
  const emit = async (chunk) => {
    const ok = await write(chunk);
    beat?.touch();
    return ok;
  };

  /** @returns true when the frame should be forwarded. */
  const inspect = (data) => {
    if (!data) return true;
    if (data === DONE_MARK) {
      terminal = true;
      return true;
    }
    if (data.includes(ERROR_MARK)) {
      try {
        const json = JSON.parse(data);
        if (json && json.error) {
          failure = typeof json.error === "object" ? json.error : { message: String(json.error) };
          return false;
        }
      } catch {
        // Not JSON: leave it to the client.
      }
    }
    if (FINISH_MARK.test(data)) terminal = true;
    if (data.includes(USAGE_MARK)) {
      try {
        const json = JSON.parse(data);
        if (json && json.usage) onUsage?.(json.usage, json.model);
      } catch {}
    }
    return true;
  };

  try {
    for await (const chunk of body) {
      const text = dec.decode(chunk, { stream: true });
      // Fast path only when the chunk ends on a frame boundary: a chunk that ends
      // mid-frame can have its error/finish/usage mark in the *next* chunk, and
      // forwarding it blind would split the frame past the guard.
      if (
        !buf &&
        text.endsWith("\n\n") &&
        !text.includes(ERROR_MARK) &&
        !FINISH_MARK.test(text) &&
        !text.includes(USAGE_MARK) &&
        !text.includes(DONE_MARK)
      ) {
        if (!(await emit(chunk))) return { failed: false, stopped: true };
        continue;
      }
      buf += text;
      if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
      let split;
      while ((split = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split + 2);
        if (inspect(frameData(raw)) && !(await emit(Buffer.from(raw + "\n\n")))) {
          return { failed: false, stopped: true };
        }
        if (failure) break;
      }
      if (failure) break;
    }
  } catch (err) {
    // A reset connection throws instead of ending the iterator. Treat it like
    // the EOF case below so the caller still gets a retryable error frame.
    if (err?.name === "AbortError") return { failed: false, stopped: true };
    if (!failure) failure = { message: String(err?.message || err) };
  }

  if (!failure) {
    // A final frame often arrives without its terminating blank line, and it is
    // usually the one carrying finish_reason and usage. Forward it like any
    // other frame instead of only inspecting it, or the client never sees the
    // end of the turn.
    buf += dec.decode();
    if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
    if (buf.trim()) {
      for (const raw of buf.split("\n\n")) {
        if (!raw.trim()) continue;
        const data = frameData(raw);
        if (data === null) continue; // a comment/keep-alive tail, not an event
        if (data !== DONE_MARK && !isJson(data)) {
          // Half a frame: the upstream died mid-write.
          if (!failure) failure = { message: "upstream closed the stream mid-frame" };
          break;
        }
        if (!inspect(data)) break;
        if (!(await emit(Buffer.from(raw + "\n\n")))) {
          return { failed: false, stopped: true };
        }
      }
    }
    // inspect() may already have found the real failure in the tail; do not
    // replace its message with the generic EOF one.
    if (!terminal && !failure) failure = { message: "upstream closed the stream without a finish frame" };
  }

  if (failure) {
    const error = {
      message: streamFailureMessage(failure.message),
      type: "upstream_error",
      code: "upstream_stream_error",
    };
    await emit(Buffer.from("data: " + JSON.stringify({ error }) + "\n\n"));
    return { failed: true, stopped: false, error };
  }
  return { failed: false, stopped: false };
}
