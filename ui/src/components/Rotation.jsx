import React from "react";
import { cx } from "../api.js";
import { Card, Toggle } from "./ui.jsx";

/**
 * Proportional weight track.
 *
 * Purpose: one glance answers "where does my traffic go" - segment width is the
 * account's share of the weighted ring, and the highlighted segment fires next.
 * Chips were decorative; this encodes the data.
 */
function Track({ accounts, rotation, roundRobin }) {
  if (!roundRobin || !rotation || !Array.isArray(rotation.order) || rotation.order.length === 0) {
    return (
      <p className="text-[12px] text-slate-400">
        {roundRobin
          ? "Add an account to build the rotation."
          : "Pinned to " + (rotation && rotation.active ? rotation.active : "the active account") + "."}
      </p>
    );
  }

  const totalWeight = rotation.totalWeight || accounts.reduce((s, a) => s + (a.weight || 1), 0) || 1;
  const nextName = rotation.nextName;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          traffic split
        </span>
        <span className="tnum font-mono text-[11px] text-slate-400">
          {rotation.order.length} slots / {totalWeight} weight
        </span>
      </div>

      <div
        role="img"
        aria-label={
          "Weighted rotation: " +
          accounts.map((a) => a.name + " " + Math.round(((a.weight || 1) / totalWeight) * 100) + "%").join(", ")
        }
        className="flex h-9 w-full overflow-hidden rounded-lg border border-white/12"
      >
        {accounts.map((a, i) => {
          const share = (a.weight || 1) / totalWeight;
          const isNext = a.name === nextName;
          return (
            <div
              key={a.name || a.index}
              title={a.name + " - weight " + (a.weight || 1) + " (" + Math.round(share * 100) + "%)"}
              className={cx(
                "relative flex min-w-0 items-center justify-center border-white/10",
                i > 0 ? "border-l" : "",
                isNext ? "bg-emerald-400/25" : "bg-blue-400/[0.09]",
              )}
              style={{ flexGrow: a.weight || 1, flexBasis: 0 }}
            >
              <span
                className={cx(
                  "truncate px-1.5 font-mono text-[11px] font-semibold",
                  isNext ? "text-emerald-200" : "text-blue-200/80",
                )}
              >
                {a.name}
              </span>
              <span
                aria-hidden="true"
                className="absolute bottom-0.5 right-1 font-mono text-[9px] text-slate-400"
              >
                {Math.round(share * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-emerald-400/60" />
          fires next: <span className="font-mono text-emerald-300">{nextName || "-"}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-blue-400/30" />
          queued
        </span>
      </div>
    </div>
  );
}

export default function RotationCard({ settings, rotation, accounts, busy, onRotation, onMachine }) {
  const roundRobin = settings.rotation !== "single";

  return (
    <Card title="Rotation" step="1" id="rotation">
      <div className="space-y-5">
        <Track accounts={accounts} rotation={rotation} roundRobin={roundRobin} />
        <div className="h-px" style={{ background: "var(--hairline)" }} />
        <Toggle
          checked={roundRobin}
          disabled={busy}
          onChange={(next) => onRotation(next ? "round-robin" : "single")}
          label="Round-robin"
          hint={roundRobin ? "requests follow the weighted split above" : "every request uses the active account"}
        />
        <div className="h-px" style={{ background: "var(--hairline)" }} />
        <Toggle
          checked={settings.sendMachineHeader === true}
          disabled={busy}
          onChange={onMachine}
          label="Machine header"
          hint={
            settings.sendMachineHeader === true
              ? "each account sends its own X-DeepAI-Code-Machine digest"
              : "safe default - no digest sent. Verify tests both ways"
          }
        />
      </div>
    </Card>
  );
}
