import React, { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../api.js";

/**
 * Command palette (Ctrl/Cmd+K, or "/").
 * Purpose: every destructive or hidden action is reachable by keyboard without
 * hunting through hover-revealed rows. Search is a subsequence match, so
 * "rmall" finds "Remove all accounts".
 */
function subsequence(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j += 1) if (t[j] === q[i]) i += 1;
  return i === q.length;
}

export default function CommandPalette({ commands, open, setOpen }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current && inputRef.current.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands.filter((c) => subsequence(query, c.label + " " + (c.group || "")));
  }, [commands, query]);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results.length, active]);

  if (!open) return null;

  function choose(cmd) {
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass palette-in w-[min(34rem,100%)] overflow-hidden rounded-2xl shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--hairline)" }}>
          <span aria-hidden="true" className="mono text-[13px] text-blue-300">›</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % Math.max(1, results.length)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + results.length) % Math.max(1, results.length)); }
              if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
            }}
            placeholder="Search commands..."
            aria-label="Search commands"
            className="w-full bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
          />
          <span className="kbd">esc</span>
        </div>

        <ul role="listbox" aria-label="Commands" className="scroll-thin max-h-[19rem] overflow-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-[12px] text-slate-400">no commands match</li>
          ) : null}
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c)}
                className={cx(
                  "flex w-full items-center gap-3 px-4 py-2 text-left text-[12.5px] transition-colors",
                  i === active ? "bg-white/[0.07] text-slate-100" : "text-slate-300 hover:bg-white/[0.04]",
                )}
              >
                <span aria-hidden="true" className={cx("mono w-4 text-center text-[11px]", i === active ? "text-blue-300" : "text-slate-500")}>
                  {c.glyph || "·"}
                </span>
                <span className="flex-1">{c.label}</span>
                <span className="text-[10.5px] text-slate-500">{c.group}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3 border-t px-4 py-2 text-[10.5px] text-slate-500" style={{ borderColor: "var(--hairline)" }}>
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> navigate</span>
          <span><span className="kbd">↵</span> run</span>
          <span className="ml-auto">{results.length} commands</span>
        </div>
      </div>
    </div>
  );
}
