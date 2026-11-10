import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, cx, fmtUptime } from "./api.js";
import { Pill, Toasts, Button } from "./components/ui.jsx";
import RotationCard from "./components/Rotation.jsx";
import AccountsCard from "./components/Accounts.jsx";
import LoginCard from "./components/Login.jsx";
import { UsageHero, UsageDetail } from "./components/Usage.jsx";
import TestCard from "./components/TestPanel.jsx";
import Clock from "./components/Clock.jsx";
import CommandPalette from "./components/CommandPalette.jsx";

const EMPTY = {
  count: 0,
  accounts: [],
  settings: { rotation: "round-robin", active: "", sendMachineHeader: false },
  rotation: { order: [], nextIndex: 0, totalWeight: 0, nextName: null },
  accountsRevision: 0,
};

/* ---------------------------------------------------------------- rail */

function Rail({ online, signedIn, onPalette }) {
  const dot = !online ? "bg-rose-400" : signedIn ? "bg-emerald-400" : "bg-amber-400";
  return (
    <aside
      className="sticky top-0 hidden h-screen w-14 shrink-0 flex-col items-center border-r py-4 lg:flex"
      style={{ borderColor: "var(--hairline)" }}
      aria-label="Sidebar"
    >
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 font-mono text-[11px] font-extrabold text-white shadow-lg shadow-blue-900/40">
        DA
      </div>

      <div className="mt-7 flex flex-1 flex-col items-center gap-4">
        <span
          className="block font-mono text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500"
          style={{ writingMode: "vertical-rl" }}
        >
          deepai proxy
        </span>
        <button
          type="button"
          onClick={onPalette}
          aria-label="Open command palette (Control K)"
          title="Command palette  Ctrl+K"
          className="mt-auto grid h-8 w-8 place-items-center rounded-lg border border-white/12 text-[13px] text-slate-400 transition-colors hover:border-white/30 hover:text-slate-100"
        >
          ⌘
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <span className={cx("h-2 w-2 rounded-full", dot, online && signedIn ? "live-dot" : "")} />
        <Clock className="text-[9.5px] tracking-tight text-slate-500" />
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- app */

export default function App() {
  const [data, setData] = useState(EMPTY);
  const [health, setHealth] = useState(null);
  const [usage, setUsage] = useState(null);
  const [models, setModels] = useState([]);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const [loginName, setLoginName] = useState("");
  const [toasts, setToasts] = useState([]);
  const [online, setOnline] = useState(true);

  const revisionRef = useRef(0);
  const toastId = useRef(0);

  const toast = useCallback((text, tone) => {
    const id = ++toastId.current;
    setToasts((prev) => prev.concat({ id, text, tone: tone || "info" }));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  const dismiss = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const apply = useCallback((payload) => {
    if (!payload) return;
    setData((prev) => {
      const next = Object.assign({}, prev, payload);
      if (payload.settings) next.settings = payload.settings;
      if (payload.rotation) next.rotation = payload.rotation;
      if (Array.isArray(payload.accounts)) next.accounts = payload.accounts;
      if (typeof payload.count === "number") next.count = payload.count;
      if (typeof payload.accountsRevision === "number") {
        next.accountsRevision = payload.accountsRevision;
        revisionRef.current = payload.accountsRevision;
      }
      return next;
    });
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      apply(await api.accounts());
      return true;
    } catch (err) {
      toast("Could not load accounts: " + err.message, "err");
      return false;
    }
  }, [apply, toast]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setOnline(true);
      return h;
    } catch {
      setOnline(false);
      setHealth(null);
      return null;
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await api.usage());
    } catch {
      /* keep previous numbers - a missed poll is not an event */
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const m = await api.models();
      setModels(((m && m.data) || []).map((x) => x.id));
    } catch (err) {
      toast("Could not load models: " + err.message, "err");
    }
  }, [toast]);

  useEffect(() => {
    refreshHealth().then(refreshAccounts);
    refreshUsage();
    loadModels();
  }, [refreshAccounts, refreshHealth, refreshUsage, loadModels]);

  useEffect(() => {
    const t = setInterval(() => {
      refreshUsage();
      refreshHealth();
    }, 5000);
    return () => clearInterval(t);
  }, [refreshHealth, refreshUsage]);

  // completed sign-in watcher
  useEffect(() => {
    if (!waiting) return undefined;
    const before = revisionRef.current;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      const h = await refreshHealth();
      if (h && h.signedIn && (h.accountsRevision || 0) !== before) {
        setWaiting(false);
        setAuthUrl("");
        toast("Signed in. Accounts: " + h.accountCount, "ok");
        refreshAccounts();
        refreshUsage();
      } else if (tries >= 150) {
        setWaiting(false);
        toast("Login timed out. Paste the callback URL to finish.", "err");
      }
    }, 2000);
    return () => clearInterval(t);
  }, [waiting, refreshAccounts, refreshHealth, refreshUsage, toast]);

  async function withBusy(fn) {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }

  const onWeight = (index, weight) =>
    withBusy(async () => {
      try {
        apply(await api.patchAccount(index, { weight }));
        toast("Weight " + weight + " for account #" + index, "ok");
      } catch (err) {
        toast("Weight failed: " + err.message, "err");
      }
    });

  const onPin = (name) =>
    withBusy(async () => {
      try {
        apply(await api.settings({ active: name }));
        toast("Active account: " + name, "ok");
      } catch (err) {
        toast("Pin failed: " + err.message, "err");
      }
    });

  const onRemove = (index) => {
    if (!window.confirm("Remove account #" + index + "?")) return;
    withBusy(async () => {
      try {
        apply(await api.removeAccount(index));
        toast("Removed account #" + index, "ok");
        refreshHealth();
      } catch (err) {
        toast("Remove failed: " + err.message, "err");
      }
    });
  };

  const onRemoveAll = () => {
    if (!window.confirm("Remove all stored accounts?")) return;
    withBusy(async () => {
      try {
        apply(await api.removeAll());
        toast("All accounts removed", "ok");
        refreshHealth();
      } catch (err) {
        toast("Remove failed: " + err.message, "err");
      }
    });
  };

  const onRotation = (rotation) =>
    withBusy(async () => {
      try {
        apply(await api.settings({ rotation }));
        toast(rotation === "single" ? "Pinned to the active account" : "Round-robin enabled", "ok");
      } catch (err) {
        toast("Could not change rotation: " + err.message, "err");
      }
    });

  const onMachine = (on) =>
    withBusy(async () => {
      try {
        apply(await api.settings({ sendMachineHeader: on }));
        toast("Machine header " + (on ? "on" : "off"), "ok");
      } catch (err) {
        toast("Could not change the machine header: " + err.message, "err");
      }
    });

  const onCapture = () =>
    withBusy(async () => {
      try {
        const r = await api.captureImport();
        if (r.found === 0) {
          toast("No desktop app credential found", "err");
          return;
        }
        apply(r);
        toast("Found " + r.found + ", added " + r.added + ", updated " + r.updated, "ok");
        refreshHealth();
      } catch (err) {
        toast("Capture failed: " + err.message, "err");
      }
    });

  const onAdd = (payload, error) => {
    if (error) {
      toast(error, "err");
      return;
    }
    withBusy(async () => {
      try {
        const r = await api.addAccounts(payload);
        apply(r);
        const extra = r.errors && r.errors.length ? " skipped: " + r.errors.join("; ") : "";
        toast("Saved: " + r.added + " added, " + r.updated + " updated" + extra, "ok");
        refreshHealth();
      } catch (err) {
        toast("Save failed: " + err.message, "err");
      }
    });
  };

  const onExport = () =>
    withBusy(async () => {
      try {
        const payload = await api.exportAccounts();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "acc.json";
        a.click();
        URL.revokeObjectURL(a.href);
        toast("Exported " + (payload.accounts || []).length + " account(s)", "ok");
      } catch (err) {
        toast("Export failed: " + err.message, "err");
      }
    });

  const onStartLogin = () =>
    withBusy(async () => {
      try {
        const r = await api.startLogin(loginName.trim());
        setAuthUrl(r.authUrl);
        setWaiting(true);
        window.open(r.authUrl, "_blank");
        toast("Sign-in started", "info");
      } catch (err) {
        toast("Could not start login: " + err.message, "err");
      }
    });

  const onPaste = (text, done) => {
    withBusy(async () => {
      try {
        const r = await api.completeLogin(text);
        apply(r);
        const extra = r.capture && r.capture.added ? " Captured " + r.capture.added + " app credential(s)." : "";
        done(null, "Signed in as " + (r.username || "unknown") + ". Total: " + r.count + "." + extra);
        setWaiting(false);
        setAuthUrl("");
        refreshHealth();
        refreshUsage();
      } catch (err) {
        done(err.message, null);
      }
    });
  };

  const onVerify = (name) =>
    withBusy(async () => {
      setOutput("Verifying " + name + "...");
      try {
        const r = await api.verify(name);
        const lines = [];
        lines.push("account  : " + r.name + "  (" + (r.username || "?") + ", pro=" + r.isPro + ")");
        lines.push("machine  : " + String(r.machineId).slice(0, 12) + "...  (local source: " + r.machineSource + ")");
        lines.push("affinity : " + r.affinity);
        lines.push("");
        lines.push("headers:");
        Object.keys(r.headers).forEach((k) => lines.push("  " + k + ": " + r.headers[k]));
        lines.push("");
        Object.keys(r.checks).forEach((k) => {
          const c = r.checks[k];
          lines.push(k.padEnd(20) + ": " + c.status + " " + c.detail);
        });
        lines.push("");
        lines.push(r.ok ? "OK - gateway accepts " + r.name : "FAILED - " + r.hint);
        setOutput(lines.join("\n"));
        toast(r.ok ? "Verify OK for " + r.name : "Verify failed: " + r.hint, r.ok ? "ok" : "err");
      } catch (err) {
        const d = (err.data && (err.data.checks || err.data)) || {};
        setOutput("Verify failed: " + err.message + "\n" + JSON.stringify(d, null, 2));
        toast("Verify failed: " + err.message, "err");
      }
    });

  const onChat = (model, prompt) =>
    withBusy(async () => {
      if (!model || !prompt.trim()) {
        setOutput("Pick a model and type a prompt.");
        return;
      }
      setOutput("Sending through the rotation...");
      try {
        const r = await api.chat({
          model,
          messages: [{ role: "user", content: prompt.trim() }],
          stream: false,
        });
        setOutput(JSON.stringify(r, null, 2));
        refreshUsage();
      } catch (err) {
        setOutput("Error: " + err.message + "\n" + JSON.stringify(err.data || {}, null, 2));
        refreshUsage();
      }
    });

  const onCount = (prompt) =>
    withBusy(async () => {
      if (!prompt.trim()) {
        setOutput("Type something to estimate.");
        return;
      }
      try {
        const r = await api.countTokens({ messages: [{ role: "user", content: prompt.trim() }] });
        setOutput(JSON.stringify(r, null, 2));
        refreshUsage();
      } catch (err) {
        setOutput("Error: " + err.message);
      }
    });

  const signedIn = health ? health.signedIn : data.count > 0;
  const mode = data.settings.rotation === "single" ? "single" : "round-robin";
  const [paletteOpen, setPaletteOpen] = useState(false);

  const commands = [
    { id: "login", glyph: "+", label: "Login and add account", group: "account", run: () => !waiting && onStartLogin() },
    { id: "capture", glyph: "↓", label: "Auto-capture from desktop app", group: "account", run: onCapture },
    { id: "export", glyph: "↑", label: "Export all accounts", group: "account", run: onExport },
    { id: "clear", glyph: "×", label: "Remove all accounts", group: "danger", run: onRemoveAll },
    { id: "rr", glyph: "↻", label: "Enable round-robin", group: "rotation", run: () => onRotation("round-robin") },
    { id: "single", glyph: "1", label: "Pin to active account (single mode)", group: "rotation", run: () => onRotation("single") },
    { id: "machine", glyph: "M", label: "Toggle machine header", group: "rotation", run: () => onMachine(data.settings.sendMachineHeader !== true) },
    { id: "verify", glyph: "✓", label: "Verify " + (data.settings.active || "account"), group: "diagnostics", run: () => onVerify(data.settings.active || "") },
    { id: "refresh", glyph: "R", label: "Refresh everything", group: "diagnostics", run: () => { refreshHealth(); refreshAccounts(); refreshUsage(); loadModels(); } },
  ];

  return (
    <div className="relative min-h-screen">
      <div className="ambient" aria-hidden="true" />

      {!online ? (
        <div
          role="alert"
          className="relative z-20 border-b border-rose-400/30 bg-rose-500/10 px-5 py-1.5 text-center text-[12px] font-semibold text-rose-300"
        >
          proxy offline - retrying every 5s
        </div>
      ) : null}

      <div className="relative z-10 mx-auto flex max-w-[1240px]">
        <Rail online={online} signedIn={signedIn} onPalette={() => setPaletteOpen(true)} />

        <div className="min-w-0 flex-1">
          {/* slim status strip */}
          <header className="hairline-b sticky top-0 z-30 bg-[#060a12]/85 px-4 py-2.5 backdrop-blur-xl sm:px-6">
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <span className="mr-auto flex items-center gap-2.5 lg:hidden">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 font-mono text-[10px] font-extrabold text-white">
                  DA
                </span>
                <span className="text-[13px] font-bold tracking-tight">DeepAI Proxy</span>
              </span>
              <Pill tone={online ? (signedIn ? "ok" : "warn") : "err"} pulse={online && signedIn}>
                {online ? (signedIn ? "signed in" : "no account") : "offline"}
              </Pill>
              <Pill tone="idle">{data.count} {data.count === 1 ? "account" : "accounts"}</Pill>
              <Pill tone={mode === "single" ? "warn" : "info"}>{mode}</Pill>
              <Pill tone={data.settings.sendMachineHeader ? "ok" : "idle"}>
                machine {data.settings.sendMachineHeader ? "on" : "off"}
              </Pill>
              <Pill tone="idle" title={data.settings.active || ""}>
                {data.settings.active || "no active"}
              </Pill>
              <Button variant="ghost" size="xs" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
                <span className="kbd">⌘K</span>
              </Button>
              <Clock className="hidden text-[11px] text-slate-400 sm:block lg:hidden" />
            </div>
          </header>

          <main className="grid gap-4 px-4 py-4 sm:px-6 lg:grid-cols-12">
            {/* hero: the one number that matters */}
            <div className="lg:col-span-12">
              <UsageHero usage={usage} online={online} />
            </div>

            <div className="lg:col-span-7">
              <RotationCard
                settings={data.settings}
                rotation={data.rotation}
                accounts={data.accounts}
                busy={busy}
                onRotation={onRotation}
                onMachine={onMachine}
              />
            </div>

            <div className="lg:col-span-5">
              <LoginCard
                waiting={waiting}
                authUrl={authUrl}
                onStart={onStartLogin}
                onPaste={onPaste}
                busy={busy}
                loginName={loginName.trim()}
              />
            </div>

            <div className="lg:col-span-12">
              <AccountsCard
                accounts={data.accounts}
                perAccount={usage ? usage.perAccount : []}
                totalRequests={
                  usage && usage.perAccount
                    ? usage.perAccount.reduce((s, r) => s + (r.requests || 0), 0)
                    : 0
                }
                settings={data.settings}
                rotation={data.rotation}
                busy={busy}
                onWeight={onWeight}
                onPin={onPin}
                onRemove={onRemove}
                onVerify={onVerify}
                onRemoveAll={onRemoveAll}
                onExport={onExport}
                onCapture={onCapture}
                onAdd={onAdd}
                loginName={loginName}
                setLoginName={setLoginName}
              />
            </div>

            <div className="lg:col-span-7">
              <TestCard
                models={models}
                output={output}
                setOutput={setOutput}
                busy={busy}
                onChat={onChat}
                onCount={onCount}
                onReload={loadModels}
              />
            </div>

            <div className="lg:col-span-5">
              <UsageDetail usage={usage} />
            </div>
          </main>

          <footer className="hairline-b px-4 pb-6 pt-1 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-slate-500">
              <span>{health && health.upstream ? health.upstream : "upstream unknown"}</span>
              <span aria-hidden="true">/</span>
              <span>{health && health.machine ? "machine " + health.machine : "machine unknown"}</span>
              <span aria-hidden="true">/</span>
              <span>uptime {usage ? fmtUptime(usage.uptimeSeconds) : "-"}</span>
            </div>
          </footer>
        </div>
      </div>

      <CommandPalette commands={commands} open={paletteOpen} setOpen={setPaletteOpen} />
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}
