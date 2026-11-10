import React, { useState } from "react";
import { cx } from "../api.js";
import { Button, Card, Field, inputClass } from "./ui.jsx";

export default function TestCard({ models, output, setOutput, busy, onChat, onCount, onReload }) {
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("Say hello in one sentence.");
  const chosen = model || (models[0] || "");

  return (
    <Card
      title="Test"
      step="4"
      id="test"
      actions={
        <Button variant="ghost" size="xs" onClick={onReload} disabled={busy}>
          Reload models
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <Field label="Model">
          <select className={inputClass} value={chosen} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 ? <option value="">no models</option> : null}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-1.5 sm:pt-[22px]">
          <Button size="sm" onClick={() => onChat(chosen, prompt)} disabled={busy || !chosen}>
            Send
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onCount(prompt)} disabled={busy}>
            Count
          </Button>
        </div>
      </div>

      <div className="mt-3">
        <Field label="Prompt">
          <textarea
            className={cx(inputClass, "scroll-thin h-[56px] resize-y")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">output</span>
        {output ? (
          <Button variant="subtle" size="xs" onClick={() => setOutput("")}>
            clear
          </Button>
        ) : null}
      </div>
      <pre
        className="scroll-thin mt-1 max-h-[260px] overflow-auto rounded-lg border border-white/10 bg-[#03060c]/80 p-3 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words"
        aria-live="polite"
      >
        {output || "No request yet."}
      </pre>
    </Card>
  );
}
