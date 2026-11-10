import React from "react";
import { cx } from "../api.js";

/* ---------------------------------------------------------------- surfaces */

export function Card({ title, step, actions, children, className, id }) {
  return (
    <section id={id} className={cx("glass rise rounded-2xl", className)} aria-labelledby={id ? id + "-h" : undefined}>
      <header className="flex items-center gap-2.5 border-b px-5 py-3" style={{ borderColor: "var(--hairline)" }}>
        {step ? (
          <span
            aria-hidden="true"
            className="grid h-5 w-5 place-items-center rounded-md bg-blue-400/12 font-mono text-[10px] font-bold text-blue-300"
          >
            {step}
          </span>
        ) : null}
        <h2 id={id ? id + "-h" : undefined} className="text-[11.5px] font-semibold uppercase tracking-[0.16em] text-slate-300">
          {title}
        </h2>
        <div className="flex-1" />
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- actions */

const VARIANTS = {
  primary:
    "bg-blue-500 text-white hover:bg-blue-400 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]",
  ghost:
    "bg-white/[0.04] text-slate-200 border border-white/12 hover:border-white/30 hover:bg-white/[0.07]",
  danger:
    "bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 hover:text-rose-200",
  subtle: "bg-transparent text-slate-400 hover:text-slate-100",
};

const SIZES = {
  md: "h-9 px-4 text-[13px] rounded-xl",
  sm: "h-8 px-3 text-[12px] rounded-lg",
  xs: "h-7 px-2.5 text-[11px] rounded-md",
};

export function Button({ variant = "primary", size = "md", className, children, ...rest }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 font-semibold",
        "transition-[background,border-color,color,transform] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "enabled:active:scale-[0.98]",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- status */

const TONES = {
  idle: { box: "border-white/12 bg-white/[0.03] text-slate-400", dot: "bg-slate-500" },
  ok: { box: "border-emerald-400/35 bg-emerald-400/[0.08] text-emerald-300", dot: "bg-emerald-400" },
  warn: { box: "border-amber-400/35 bg-amber-400/[0.08] text-amber-300", dot: "bg-amber-400" },
  err: { box: "border-rose-400/35 bg-rose-400/[0.08] text-rose-300", dot: "bg-rose-400" },
  info: { box: "border-blue-400/35 bg-blue-400/[0.08] text-blue-300", dot: "bg-blue-400" },
};

export function Pill({ tone = "idle", pulse, title, children }) {
  const t = TONES[tone] || TONES.idle;
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap",
        t.box,
      )}
    >
      <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", t.dot, pulse ? "live-dot" : "")} />
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- toggle */

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          checked
            ? "border-transparent bg-blue-500"
            : "border-white/20 bg-white/10 hover:bg-white/15",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-150",
            checked ? "translate-x-[19px]" : "translate-x-[2px]",
          )}
        />
      </button>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-slate-100">
          {label}
          <span className={cx("ml-2 font-mono text-[11px]", checked ? "text-emerald-300" : "text-slate-500")}>
            {checked ? "on" : "off"}
          </span>
        </div>
        {hint ? <div className="text-[11.5px] leading-snug text-slate-400">{hint}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- forms */

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-white/12 bg-[#070b14]/80 px-3 py-2 text-[12.5px] text-slate-100 transition-colors placeholder:text-slate-600";

export function Note({ tone = "idle", children }) {
  if (!children) return null;
  const colors = { idle: "text-slate-400", ok: "text-emerald-400", err: "text-rose-400", warn: "text-amber-400" };
  return (
    <p role="status" className={cx("mt-2 text-[12px] leading-snug break-words", colors[tone])}>
      {children}
    </p>
  );
}

export function Spinner() {
  return <span aria-hidden="true" className="spinner inline-block h-3 w-3 rounded-full border-2 border-white/25 border-t-white" />;
}

/* ---------------------------------------------------------------- toasts */

export function Toasts({ items, onDismiss }) {
  return (
    <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(21rem,90vw)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            "glass pointer-events-auto rise flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] leading-snug",
            t.tone === "ok" ? "border-emerald-400/30" : t.tone === "err" ? "border-rose-400/30" : "border-blue-400/25",
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
              t.tone === "ok" ? "bg-emerald-400" : t.tone === "err" ? "bg-rose-400" : "bg-blue-400",
            )}
          />
          <span className="flex-1 text-slate-200">{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            className="text-slate-500 transition-colors hover:text-slate-200"
          >
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
