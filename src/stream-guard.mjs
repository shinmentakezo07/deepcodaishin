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

export const STREAM_FAILURE_PREFIX = "502 upstream stream interrupted";

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

/**
 * Forward `body` to `write`, replacing a terminal upstream failure with a
 * retryable one.
 *
 * @param body   upstream response body (async iterable of Uint8Array).
 * @param write  async (chunk: Uint8Array) => boolean; false stops the relay
 *               (the client hung up).
 * @param onUsage called for every frame that carries a usage block.
 * @returns {{ failed: boolean, stopped: boolean, error?: object }}
 */
export async function relayGuarded(body, { write, onUsage } = {}) {
  const dec = new TextDecoder();
  let buf = "";
  let terminal = false;
  let failure = null;

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

  for await (const chunk of body) {
    const text = dec.decode(chunk, { stream: true });
    if (
      !text.includes(ERROR_MARK) &&
      !FINISH_MARK.test(text) &&
      !text.includes(USAGE_MARK) &&
      !text.includes(DONE_MARK)
    ) {
      if (!(await write(chunk))) return { failed: false, stopped: true };
      continue;
    }
    buf += text;
    let split;
    while ((split = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, split);
      buf = buf.slice(split + 2);
      if (inspect(frameData(raw)) && !(await write(Buffer.from(raw + "\n\n")))) {
        return { failed: false, stopped: true };
      }
      if (failure) break;
    }
    if (failure) break;
  }

  if (!failure) {
    // A final frame often arrives without its terminating blank line.
    buf += dec.decode();
    if (buf.trim()) {
      for (const raw of buf.split("\n\n")) {
        if (raw.trim() && !inspect(frameData(raw))) break;
      }
    }
    if (!terminal) failure = { message: "upstream closed the stream without a finish frame" };
  }

  if (failure) {
    const error = {
      message: streamFailureMessage(failure.message),
      type: "upstream_error",
      code: "upstream_stream_error",
    };
    await write(Buffer.from("data: " + JSON.stringify({ error }) + "\n\n"));
    return { failed: true, stopped: false, error };
  }
  return { failed: false, stopped: false };
}
