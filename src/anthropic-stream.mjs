import crypto from "node:crypto";
import { STOP_MAP } from "./openai-to-anthropic.mjs";
import { recordUsage } from "./metrics.mjs";

function sseChunk(text) {
  return `event: ${text.event}\ndata: ${JSON.stringify(text.data)}\n\n`;
}

/**
 * OpenAI SSE -> Anthropic SSE.
 * Text goes in block 0 unless a thinking block opens first; tool calls follow.
 */
function openAIToAnthropicStream(upstreamBody, model, res) {
  const dec = new TextDecoder();
  let buf = "";
  let started = false;
  let nextIndex = 0;
  let textIndex = -1;
  let thinkingIndex = -1;
  const toolBlocks = new Map(); // openai tool_call index -> { blockIndex, id, name, open }
  let finish = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

  // Backpressure: res.write() returns false when the socket buffer is full.
  // Remembering that and awaiting 'drain' once per upstream chunk keeps memory
  // flat for a slow client instead of queueing the whole answer in the process.
  let needDrain = false;
  const write = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.write(sseChunk({ event, data }))) needDrain = true;
  };
  const drained = () =>
    new Promise((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.on("drain", done);
      res.on("close", done);
    });

  const ensureStart = (u) => {
    if (started) return;
    started = true;
    write("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: u?.prompt_tokens ?? 0, output_tokens: 0 },
      },
    });
  };

  const openText = () => {
    if (textIndex >= 0) return;
    textIndex = nextIndex++;
    write("content_block_start", {
      type: "content_block_start",
      index: textIndex,
      content_block: { type: "text", text: "" },
    });
  };

  const closeText = () => {
    if (textIndex < 0) return;
    write("content_block_stop", { type: "content_block_stop", index: textIndex });
    textIndex = -1;
  };

  const openThinking = () => {
    if (thinkingIndex >= 0) return;
    thinkingIndex = nextIndex++;
    write("content_block_start", {
      type: "content_block_start",
      index: thinkingIndex,
      content_block: { type: "thinking", thinking: "" },
    });
  };

  const closeThinking = () => {
    if (thinkingIndex < 0) return;
    write("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
    thinkingIndex = -1;
  };

  const handleChunk = (json) => {
    if (json?.id) id = json.id;
    if (json?.usage) {
      usage = {
        input_tokens: json.usage.prompt_tokens ?? usage.input_tokens,
        output_tokens: json.usage.completion_tokens ?? usage.output_tokens,
        cached: json.usage.prompt_tokens_details?.cached_tokens,
      };
    }
    ensureStart(json?.usage);

    const choice = json?.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};

    const thinking = d.reasoning_content ?? d.reasoning;
    if (typeof thinking === "string" && thinking) {
      openThinking();
      write("content_block_delta", {
        type: "content_block_delta",
        index: thinkingIndex,
        delta: { type: "thinking_delta", thinking },
      });
    }

    if (typeof d.content === "string" && d.content) {
      closeThinking();
      openText();
      write("content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text: d.content },
      });
    }

    for (const tc of d.tool_calls || []) {
      const key = tc.index ?? 0;
      let entry = toolBlocks.get(key);
      if (!entry) {
        closeThinking();
        closeText();
        entry = { blockIndex: nextIndex++, id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`, name: tc.function?.name || "tool" };
        toolBlocks.set(key, entry);
        write("content_block_start", {
          type: "content_block_start",
          index: entry.blockIndex,
          content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} },
        });
      } else if (tc.function?.name && entry.name === "tool") {
        entry.name = tc.function.name;
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args) {
        write("content_block_delta", {
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  };

  return new Promise((resolve) => {
    void (async () => {
      try {
        let stopped = false;
        for await (const chunk of upstreamBody) {
          // Stop pulling from upstream the moment the caller is gone.
          if (res.writableEnded || res.destroyed) {
            stopped = true;
            break;
          }
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
              handleChunk(JSON.parse(data));
            } catch {}
          }
          if (needDrain) {
            needDrain = false;
            await drained();
          }
        }
        // Flush a last frame that arrived without its terminating blank line.
        if (!stopped) {
          buf += dec.decode();
          for (const line of buf.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              handleChunk(JSON.parse(data));
            } catch {}
          }
        }
        ensureStart({ prompt_tokens: usage.input_tokens });
        closeThinking();
        closeText();
        for (const entry of toolBlocks.values()) {
          write("content_block_stop", { type: "content_block_stop", index: entry.blockIndex });
        }
        write("message_delta", {
          type: "message_delta",
          delta: { stop_reason: STOP_MAP[finish] || "end_turn", stop_sequence: null },
          usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        });
        recordUsage(usage, model);
        write("message_stop", { type: "message_stop" });
      } catch (err) {
        write("error", { type: "error", error: { type: "api_error", message: String(err?.message || err) } });
      } finally {
        if (!res.writableEnded) res.end();
        resolve();
      }
    })();
  });
}

export { openAIToAnthropicStream };
