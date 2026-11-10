import React, { useState } from "react";
import { cx } from "../api.js";
import { Button, Card, inputClass } from "./ui.jsx";

function Avatar({ name }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.05] font-mono text-[13px] font-bold text-slate-300"
    >
      {initial}
    </div>
  );
}

function Stepper({ value, onChange, disabled, label }) {
  return (
    <div className="flex items-center rounded-md border border-white/12 bg-[#070b14]/70">
      <button
        type="button"
        aria-label={"Decrease weight for " + label}
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
        className="grid h-6 w-6 place-items-center rounded-l text-slate-400 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white disabled:opacity-30"
      >
        -
      </button>
      <span aria-label={"Weight " + value} className="tnum w-7 text-center font-mono text-[12px] font-bold text-slate-100">
        {value}
      </span>
      <button
        type="button"
        aria-label={"Increase weight for " + label}
        disabled={disabled || value >= 20}
        onClick={() => onChange(value + 1)}
        className="grid h-6 w-6 place-items-center rounded-r text-slate-400 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

function RequestChip({ count, rejected, share }) {
  if (!count) {
    return <span className="font-mono text-[10.5px] text-slate-600">0 req</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10.5px] text-slate-400"
      title={count + " requests" + (rejected ? ", " + rejected + " rejected" : "") + (share ? ", " + share + " of traffic" : "")}
    >
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-blue-400/70" />
      <span className="tnum text-slate-300">{count}</span> req
      {rejected ? <span className="text-rose-400/80">/{rejected} rej</span> : null}
    </span>
  );
}

export default function AccountsCard({
  accounts,
  perAccount,
  totalRequests,
  settings,
  rotation,
  busy,
  onWeight,
  onPin,
  onRemove,
  onVerify,
  onRemoveAll,
  onExport,
  onCapture,
  onAdd,
  loginName,
  setLoginName,
}) {
  const [json, setJson] = useState("");
  const single = settings.rotation === "single";
  const usageFor = (a) =>
    (perAccount || []).find((u) => u.id === a.id) ||
    (perAccount || []).find((u) => u.name === a.name);
  const nextName = rotation ? rotation.nextName : null;

  function readFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setJson(String(reader.result || ""));
    reader.readAsText(file);
  }

  function submitJson() {
    let parsed;
    try {
      parsed = JSON.parse(json || "{}");
    } catch (err) {
      onAdd(null, "Invalid JSON: " + err.message);
      return;
    }
    setJson("");
    onAdd(parsed, null);
  }

  return (
    <Card
      title="Accounts"
      step="2"
      id="accounts"
      actions={
        <div className="flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={onCapture} disabled={busy}>
            Auto-capture
          </Button>
          <Button variant="ghost" size="xs" onClick={onExport} disabled={busy || accounts.length === 0}>
            Export
          </Button>
          <Button variant="danger" size="xs" onClick={onRemoveAll} disabled={busy || accounts.length === 0}>
            Clear
          </Button>
        </div>
      }
    >
      <div className="space-y-1">
        {accounts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/12 px-4 py-8 text-center text-[12.5px] text-slate-400">
            No accounts. Sign in on the right, or paste JSON below.
          </p>
        ) : null}

        {accounts.map((a) => {
          const isNext = single ? settings.active === a.name : a.name === nextName;
          const isActive = settings.active === a.name;
          return (
            <div
              key={a.index}
              className={cx(
                "group-row flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 transition-colors",
                isNext
                  ? "border-emerald-400/35 bg-emerald-400/[0.05]"
                  : "border-transparent hover:border-white/12 hover:bg-white/[0.02]",
                single && !isActive ? "opacity-55" : "",
              )}
            >
              <Avatar name={a.name || a.username} />

              <div className="min-w-[8rem] flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-semibold text-slate-100">{a.name || a.username || "unnamed"}</span>
                  <span className="font-mono text-[10px] text-slate-500">{a.maskedKey}</span>
                  {a.isPro ? (
                    <span className="rounded border border-amber-400/40 px-1 py-px text-[9.5px] font-bold uppercase text-amber-300">
                      pro
                    </span>
                  ) : null}
                  {isNext ? (
                    <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-1 py-px text-[9.5px] font-bold uppercase text-emerald-300">
                      next
                    </span>
                  ) : null}
                  {isActive ? (
                    <span className="rounded border border-blue-400/40 bg-blue-400/10 px-1 py-px text-[9.5px] font-bold uppercase text-blue-300">
                      active
                    </span>
                  ) : null}
                  {a.cooldownSeconds > 0 ? (
                    <span
                      className="rounded border border-amber-400/40 bg-amber-400/10 px-1 py-px text-[9.5px] font-bold uppercase text-amber-300"
                      title={"Refused a request - skipped for " + a.cooldownSeconds + "s"}
                    >
                      cooling {a.cooldownSeconds}s
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-slate-500">
                  {a.machineId ? <span>machine {a.machineId}...</span> : null}
                  <RequestChip
                    count={(usageFor(a) || {}).requests || 0}
                    rejected={(usageFor(a) || {}).rejected || 0}
                    share={
                      totalRequests > 0 && (usageFor(a) || {}).requests
                        ? Math.round(((usageFor(a) || {}).requests / totalRequests) * 100) + "%"
                        : ""
                    }
                  />
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Stepper
                  value={a.weight || 1}
                  disabled={busy}
                  label={a.name}
                  onChange={(v) => onWeight(a.index, v)}
                />
                <div className="reveal flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || isActive}
                    onClick={() => onPin(a.name)}
                    title="Use this account when rotation is off"
                  >
                    {isActive ? "Pinned" : "Pin"}
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => onVerify(a.name)}>
                    Verify
                  </Button>
                  <Button variant="danger" size="xs" disabled={busy} onClick={() => onRemove(a.index)}>
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              name for the next account
            </span>
            <input
              className={inputClass}
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="defaults to the username"
              aria-label="Name for the next added account"
            />
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              load a json file
            </span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={readFile}
              aria-label="Load accounts from a JSON file"
              className="w-full cursor-pointer rounded-lg border border-white/12 bg-[#070b14]/80 px-2.5 py-1.5 text-[11.5px] text-slate-400 file:mr-2 file:rounded-md file:border-0 file:bg-white/10 file:px-2 file:py-0.5 file:text-[11px] file:text-slate-200"
            />
          </div>
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              or paste accounts
            </span>
            <textarea
              className={cx(inputClass, "scroll-thin h-[58px] resize-y font-mono text-[11px]")}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"apiKey":"...","username":"...","weight":1}'
              aria-label="Paste account JSON"
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={submitJson} disabled={busy || !json.trim()}>
            Save accounts
          </Button>
          <span className="text-[10.5px] leading-snug text-slate-500">
            Auto-capture needs the desktop app on this machine; in a container paste the key instead.
          </span>
        </div>
      </div>
    </Card>
  );
}
