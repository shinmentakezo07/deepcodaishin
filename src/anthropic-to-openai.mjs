// ---------------------------------------------------------------- anthropic -> openai

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("");
}

function imagePart(block) {
  const src = block.source;
  if (src?.type === "base64") {
    return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src?.type === "url") return { type: "image_url", image_url: { url: src.url } };
  return null;
}

function anthropicToOpenAI(req) {
  const messages = [];

  if (req.system) {
    const sys = Array.isArray(req.system) ? blocksToText(req.system) : String(req.system);
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const m of req.messages || []) {
    if (m.role === "user") {
      const parts = [];
      const toolResults = [];
      for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
        if (!b) continue;
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image") {
          const p = imagePart(b);
          if (p) parts.push(p);
        } else if (b.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content:
              typeof b.content === "string"
                ? b.content
                : (b.content || [])
                    .map((c) => (c?.type === "text" ? c.text : `[${c?.type || "block"}]`))
                    .join("\n"),
          });
        } else if (b.type === "document") {
          parts.push({ type: "text", text: "[document omitted]" });
        }
      }
      messages.push(...toolResults);
      if (parts.length) {
        messages.push({
          role: "user",
          content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts,
        });
      }
    } else if (m.role === "assistant") {
      const text = [];
      const toolCalls = [];
      for (const b of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]) {
        if (!b) continue;
        if (b.type === "text") text.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg = { role: "assistant", content: text.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const out = {
    model: req.model,
    messages,
    stream: false,
  };
  if (req.max_tokens != null) out.max_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences;

  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools
      .filter((t) => t.type === "custom" ? false : true)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || undefined,
          parameters: t.input_schema || { type: "object", properties: {} },
        },
      }));
    const tc = req.tool_choice;
    if (tc?.type === "auto") out.tool_choice = "auto";
    else if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "none") out.tool_choice = "none";
  }

  // Anthropic `thinking` -> OpenAI reasoning_effort (same mapping the app uses).
  if (req.thinking?.type === "enabled") {
    const b = Number(req.thinking.budget_tokens || 0);
    out.reasoning_effort = b >= 32000 ? "high" : b >= 8000 ? "medium" : b > 0 ? "low" : undefined;
    if (out.reasoning_effort === undefined) delete out.reasoning_effort;
  } else if (req.thinking?.type === "disabled") {
    out.reasoning_effort = "none";
  }

  return out;
}

export { anthropicToOpenAI };
