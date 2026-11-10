import crypto from "node:crypto";

const STOP_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function openAIToAnthropic(resp, model) {
  const choice = resp?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content || msg.reasoning) {
    content.push({ type: "thinking", thinking: msg.reasoning_content || msg.reasoning, signature: "" });
  }
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) if (p?.type === "text" && p.text) content.push({ type: "text", text: p.text });
  }
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  const u = resp?.usage || {};
  return {
    id: resp?.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: resp?.model || model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export { STOP_MAP, openAIToAnthropic };
