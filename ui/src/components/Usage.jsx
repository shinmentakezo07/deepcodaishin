import React from "react";
import { cx, fmtNum, fmtUptime, fmtTime } from "../api.js";
import { Card, Pill } from "./ui.jsx";

/* tiny bar chart: request mix. Pure CSS, no SVG, no third-party chart cost. */
function RequestMix({ usage }) {
  const parts = [
    { label: "chat", value: usage.chatRequests || 0, color: "rgba(126,162,255,0.75)" },
    { label: "messages", value: usage.messageRequests || 0, color: "rgba(174,122,255,0.7)" },
    { label: "count", value: usage.countTokenRequests || 0, color: "rgba(62,224,143,0.65)" },
    { label: "errors", value: usage.errors || 0, color: "rgba(255,123,135,0.75)" },
  ];
  const max = Math.max(1, ...parts.map((p) => p.value));

  return (
    <div className="flex h-16 items-end gap-2" role="img" aria-label={
      "Request mix: " + parts.map((p) => p.label + " " + p.value).join(", ")
    }>
      {parts.map((p) => (
        <div key={p.label} className="flex h-full flex-1 flex-col justify-end gap-1">
          <span className="tnum mono text-right text-[9.5px] text-slate-500">{p.value}</span>
          <div
            className="bar-in w-full rounded-t-sm"
            style={{ height: Math.max(2, (p.value / max) * 30) + "px", backgroundColor: p.color }}
            title={p.label + ": " + p.value}
          />
          <span className="truncate text-center text-[9.5px] text-slate-500">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

function Meta({ label, value, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="label">{label}</dt>
      <dd
        className={cx("tnum mono truncate text-[12px]", tone === "bad" ? "text-rose-300" : "text-slate-200")}
        title={String(value)}
      >
        {value}
      </dd>
    </div>
  );
}

export function UsageHero({ usage, online }) {
  const u = usage || {};
  return (
    <section className="glass rise relative overflow-hidden rounded-2xl" aria-label="Usage summary">
      {/* ghost numeral: depth without an image */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-2 -top-8 select-none font-mono text-[9rem] font-bold leading-none text-white/[0.018]"
      >
        Σ
      </span>
      <div className="relative grid grid-cols-1 divide-y sm:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] sm:divide-x sm:divide-y-0" style={{ borderColor: "var(--hairline)" }}>
        <div className="px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="label">total tokens</span>
            <Pill tone={online ? "ok" : "err"} pulse={online}>{online ? "live" : "offline"}</Pill>
          </div>
          <div className="display mt-2 text-slate-100">{fmtNum(u.totalTokens)}</div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-slate-400">
            <span><span className="tnum mono text-slate-200">{fmtNum(u.promptTokens)}</span> prompt</span>
            <span><span className="tnum mono text-slate-200">{fmtNum(u.completionTokens)}</span> completion</span>
            <span><span className="tnum mono text-slate-200">{fmtNum(u.requests)}</span> requests</span>
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x px-2 py-5" style={{ borderColor: "var(--hairline)" }}>
          {[
            ["uptime", fmtUptime(u.uptimeSeconds)],
            ["errors", fmtNum(u.errors)],
            ["last", u.lastAccount || "-"],
          ].map(([label, value], i) => (
            <div key={label} className="flex flex-col justify-center px-3">
              <div className="label">{label}</div>
              <div className={cx(
                "tnum mt-1 truncate font-semibold leading-tight",
                i === 1 ? "text-[20px]" : "text-[15px]",
                label === "errors" && Number(u.errors) > 0 ? "text-rose-300" : "text-slate-200",
                i === 2 ? "mono text-[12px]" : "",
              )}>
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PerAccount({ rows }) {
  const total = (rows || []).reduce((sum, r) => sum + (r.requests || 0), 0);
  if (!rows || rows.length === 0) {
    return (
      <p className="text-[11.5px] text-slate-500">No requests yet this run.</p>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.requests));
  return (
    <ul className="space-y-1.5" aria-label="Requests per account">
      {rows.map((r) => {
        const share = total > 0 ? Math.round((r.requests / total) * 100) : 0;
        return (
          <li key={r.id || r.name} className="flex items-center gap-2">
            <span className="w-[7.5rem] shrink-0 truncate font-mono text-[11px] text-slate-300" title={r.name}>
              {r.name || r.id}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                className="block h-full rounded-full bg-blue-400/70"
                style={{ width: Math.max(2, (r.requests / max) * 100) + "%" }}
              />
            </span>
            <span className="tnum mono w-10 shrink-0 text-right text-[11px] text-slate-200">{r.requests}</span>
            <span className="tnum w-8 shrink-0 text-right text-[10px] text-slate-500">{share}%</span>
            {r.rejected ? (
              <span className="shrink-0 font-mono text-[9.5px] text-rose-400/80" title={r.rejected + " rejected"}>
                {r.rejected}r
              </span>
            ) : (
              <span className="w-3 shrink-0" />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function UsageDetail({ usage }) {
  const u = usage || {};
  return (
    <Card title="Detail" id="detail">
      <RequestMix usage={u} />
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="label">requests per account</span>
          <span className="tnum mono text-[10.5px] text-slate-500">
            {(u.perAccount || []).reduce((s, r) => s + (r.requests || 0), 0)} attempts / {u.requests || 0} requests
          </span>
        </div>
        <PerAccount rows={u.perAccount} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
        <Meta label="chat" value={fmtNum(u.chatRequests)} />
        <Meta label="messages" value={fmtNum(u.messageRequests)} />
        <Meta label="token count" value={fmtNum(u.countTokenRequests)} />
        <Meta label="prompt tokens" value={fmtNum(u.promptTokens)} />
        <Meta label="completion" value={fmtNum(u.completionTokens)} />
        <Meta label="errors" value={fmtNum(u.errors)} tone={Number(u.errors) > 0 ? "bad" : undefined} />
        <Meta label="last account" value={u.lastAccount || "-"} />
        <Meta label="last model" value={u.lastModel || "-"} />
        <Meta label="last request" value={fmtTime(u.lastRequestAt)} />
        <Meta label="started" value={u.startedAt ? fmtTime(u.startedAt) : "-"} />
      </dl>
    </Card>
  );
}
