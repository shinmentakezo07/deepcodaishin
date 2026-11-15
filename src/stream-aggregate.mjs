import crypto from "node:crypto";
import { streamFailureMessage } from "./stream-guard.mjs";

// ---------------------------------------------------------------- streaming

/** Fold an upstream SSE stream into one OpenAI chat.completion object. */
async function aggregateStream(body, model) {
  const dec = new TextDecoder();
  let buf = "";
  const out = {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        logprobs: null,
        finish_reason: null,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  const msg = out.choices[0].message;
  const tools = new Map();
  // The streaming path rewrites an in-band error frame or an EOF without a
  // finish_reason into a retryable failure (stream-guard.mjs). The aggregate
  // path must do the same, or a truncated turn becomes a 200 with an empty
  // message and finish_reason "stop" - silent data loss for the caller.
  let failure = null;
  // [DONE] is a terminal frame too: the streaming guard accepts it without a
  // finish_reason, so the aggregate path must not call the same stream truncated.
  let sawDone = false;

  const handle = (json) => {
    if (json?.error) {
      if (!failure) {
        const e = json.error;
        failure = {
          message:
            typeof e === "object" && e !== null && typeof e.message === "string" ? e.message : String(e),
        };
      }
      return;
    }
    if (json?.id) out.id = json.id;
    if (json?.model) out.model = json.model;
    if (json?.usage) {
      // Merge, do not replace: a stream may report prompt tokens in one frame
      // and completion tokens in another, and replacing would zero the first.
      const u = json.usage;
      const prompt = u.prompt_tokens ?? out.usage.prompt_tokens;
      const completion = u.completion_tokens ?? out.usage.completion_tokens;
      out.usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: u.total_tokens ?? prompt + completion,
        ...(u.prompt_tokens_details
          ? { prompt_tokens_details: u.prompt_tokens_details }
          : out.usage.prompt_tokens_details
            ? { prompt_tokens_details: out.usage.prompt_tokens_details }
            : {}),
      };
    }
    const ch = json?.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (typeof d.content === "string" && d.content) msg.content = (msg.content || "") + d.content;
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (typeof reasoning === "string" && reasoning)
      msg.reasoning_content = (msg.reasoning_content || "") + reasoning;
    for (const tc of d.tool_calls || []) {
      const key = tc.index ?? 0;
      let e = tools.get(key);
      if (!e) {
        e = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
        tools.set(key, e);
      }
      if (tc.id) e.id = tc.id;
      if (tc.function?.name) e.function.name = tc.function.name;
      if (tc.function?.arguments) e.function.arguments += tc.function.arguments;
    }
    if (ch.finish_reason) out.choices[0].finish_reason = ch.finish_reason;
  };

  for await (const chunk of body) {
    const text = dec.decode(chunk, { stream: true });
    buf += text;
    if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
    let split;
    while ((split = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, split);
      buf = buf.slice(split + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      try {
        handle(JSON.parse(data));
      } catch {}
      if (failure) break;
    }
    if (failure) break;
  }

  // The last frame often arrives without its terminating blank line, and it is
  // exactly the frame that carries finish_reason and usage. Flush the decoder
  // and parse whatever is left instead of dropping it.
  buf += dec.decode();
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    try {
      handle(JSON.parse(data));
    } catch {}
  }

  if (tools.size) msg.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (!msg.content) msg.content = null;
  if (failure) {
    throw Object.assign(new Error(streamFailureMessage(failure.message)), { status: 502 });
  }
  if (!out.choices[0].finish_reason) {
    // A stream that ended without a finish_reason or [DONE] frame was cut off
    // upstream, exactly as the streaming path treats it - not a completed turn.
    if (!sawDone) {
      throw Object.assign(
        new Error(streamFailureMessage("upstream closed the stream without a finish frame")),
        { status: 502 },
      );
    }
    out.choices[0].finish_reason = tools.size ? "tool_calls" : "stop";
  }
  return out;
}



/**
 * Forward an SSE stream unchanged while parsing usage frames.
 * onUsage(usage, model) is called for every frame that carries usage.
 */
async function* tapStreamUsage(body, onUsage) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    const text = dec.decode(chunk, { stream: true });
    buf += text;
    if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
    let split;
    while ((split = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, split);
      buf = buf.slice(split + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      // Only the final frame carries usage, so parse just the frames that can
      // possibly have it: one JSON.parse + object per token becomes one per
      // stream. The check is on the raw text, where a content string can only
      // contain \"usage\" (escaped), which never matches.
      if (!data.includes('"usage"')) continue;
      try {
        const json = JSON.parse(data);
        if (json?.usage) onUsage(json.usage, json.model);
      } catch {}
    }
    yield chunk;
  }

  // A final frame with no trailing blank line still counts.
  buf += dec.decode();
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]" || !data.includes('"usage"')) continue;
    try {
      const json = JSON.parse(data);
      if (json?.usage) onUsage(json.usage, json.model);
    } catch {}
  }
}

export { aggregateStream, tapStreamUsage };
