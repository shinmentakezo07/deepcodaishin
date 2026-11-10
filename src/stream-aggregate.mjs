import crypto from "node:crypto";

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

  const handle = (json) => {
    if (json?.id) out.id = json.id;
    if (json?.model) out.model = json.model;
    if (json?.usage) {
      out.usage = {
        prompt_tokens: json.usage.prompt_tokens ?? 0,
        completion_tokens: json.usage.completion_tokens ?? 0,
        total_tokens: json.usage.total_tokens ?? 0,
        ...(json.usage.prompt_tokens_details ? { prompt_tokens_details: json.usage.prompt_tokens_details } : {}),
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
      if (!data || data === "[DONE]") continue;
      try {
        handle(JSON.parse(data));
      } catch {}
    }
  }

  if (tools.size) msg.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (!msg.content) msg.content = null;
  if (!out.choices[0].finish_reason) out.choices[0].finish_reason = tools.size ? "tool_calls" : "stop";
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
}

export { aggregateStream, tapStreamUsage };
