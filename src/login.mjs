import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { API_ORIGIN, MODEL_BASE, APP_ACCOUNT_BIN, PORT } from "./config.mjs";
import { saveAccount, captureAppAccounts } from "./account.mjs";

// ---------------------------------------------------------------- login flow

async function exchangeCode(code) {
  const res = await fetch(`${MODEL_BASE}/desktop_auth/exchange/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`exchange failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  const d = await res.json();
  if (!d || typeof d.api_key !== "string" || !d.api_key || /[\r\n]/.test(d.api_key)) {
    throw new Error("exchange returned no api_key");
  }
  return {
    apiKey: d.api_key,
    username: typeof d.username === "string" ? d.username : "",
    isPro: d.is_pro === true,
  };
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

// Pending UI sign-ins are completed by the main HTTP server on /auth-callback.
const pendingLogins = new Map();
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 20;

function prunePendingLogins() {
  const cutoff = Date.now() - LOGIN_TTL_MS;
  for (const [state, createdAt] of pendingLogins) {
    if (createdAt < cutoff) pendingLogins.delete(state);
  }
}

/**
 * Start the desktop_auth flow and register the state for the main server's
 * /auth-callback route. The callback returns to the same port as the panel, so
 * it works through whatever forwarding already reaches the panel.
 */
function startLoginFlow() {
  prunePendingLogins();
  if (pendingLogins.size >= MAX_PENDING_LOGINS) {
    const oldest = [...pendingLogins.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) pendingLogins.delete(oldest[0]);
  }
  const state = crypto.randomBytes(32).toString("hex");
  pendingLogins.set(state, Date.now());
  const authUrl = `${API_ORIGIN}/deepai_code/desktop_auth/?${new URLSearchParams({
    state,
    port: String(PORT),
  })}`;
  return { authUrl, port: PORT, state };
}

function pendingStates() {
  prunePendingLogins();
  return [...pendingLogins.keys()];
}

function captureAfterLogin() {
  try {
    const result = captureAppAccounts();
    if (result.added || result.updated) {
      console.log("auto-captured " + result.added + " app credential(s) (" + result.sources.join(", ") + ")");
    }
    return result;
  } catch (err) {
    return { found: 0, added: 0, updated: 0, sources: [], error: String(err.message || err) };
  }
}

async function finishLogin(code, state) {
  if (!code || code.length > 4096) {
    return { ok: false, status: 400, message: "missing sign-in code" };
  }
  // A pasted callback may carry a state this process did not issue (older
  // window, restarted server). Only reject a state that is clearly wrong.
  if (state && !pendingLogins.has(state) && pendingLogins.size > 0) {
    return { ok: false, status: 400, message: "invalid or expired sign-in state" };
  }
  if (state) pendingLogins.delete(state);
  try {
    const acc = await exchangeCode(code);
    saveAccount(acc);
    const capture = captureAfterLogin();
    return { ok: true, status: 200, username: acc.username || "", capture };
  } catch (err) {
    return { ok: false, status: 400, message: String(err.message || err) };
  }
}

/** Finish a UI sign-in from the main server's GET /auth-callback. */
async function handleLoginCallback(url) {
  prunePendingLogins();
  return finishLogin(url.searchParams.get("code"), url.searchParams.get("state"));
}

/**
 * Finish a sign-in from text the user pasted: either the full callback URL or a
 * bare code. Accepts the URL as-is even when the state was issued by another
 * process, so a stale browser tab can still be completed.
 */
async function completeLoginFromText(input) {
  prunePendingLogins();
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, status: 400, message: "paste the callback URL or the code" };

  let code = "";
  let state = "";
  if (/^https?:\/\//i.test(raw) || raw.includes("code=")) {
    let parsed;
    try {
      parsed = new URL(raw, "http://127.0.0.1");
    } catch {
      return { ok: false, status: 400, message: "could not parse that URL" };
    }
    code = parsed.searchParams.get("code") || "";
    state = parsed.searchParams.get("state") || "";
  } else {
    code = raw;
    state = "";
  }
  if (!code) return { ok: false, status: 400, message: "no code in that input" };
  if (!/^[A-Za-z0-9._~-]{4,4096}$/.test(code)) {
    return { ok: false, status: 400, message: "that does not look like a sign-in code" };
  }
  // The user is the one pasting, so the state is only used to retire a pending
  // flow: a URL from an older tab or a restarted server still works.
  if (state) pendingLogins.delete(state);
  return finishLogin(code, "");
}

async function login() {
  const state = crypto.randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("bad callback");
      return;
    }
    if (url.pathname !== "/auth-callback") {
      res.writeHead(404).end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    if (req.method !== "GET" || !code || code.length > 4096 || url.searchParams.get("state") !== state) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("invalid sign-in callback");
      return;
    }
    try {
      const acc = await exchangeCode(code);
      saveAccount(acc);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<h2>Signed in</h2><p>You can close this tab and return to the terminal.</p>");
      server.close();
      setTimeout(() => process.exit(0), 50);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err.message || err));
      server.close();
      setTimeout(() => process.exit(1), 50);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const authUrl = `${API_ORIGIN}/deepai_code/desktop_auth/?${new URLSearchParams({
    state,
    port: String(port),
  })}`;
  console.log(`sign-in URL:\n  ${authUrl}\n`);
  console.log(`waiting for callback on http://127.0.0.1:${port}/auth-callback ...`);
  openBrowser(authUrl);
}

function importApp() {
  let acc;
  try {
    acc = JSON.parse(fs.readFileSync(APP_ACCOUNT_BIN, "utf8"));
  } catch (err) {
    console.error(`could not read ${APP_ACCOUNT_BIN}: ${err.message}`);
    process.exit(1);
  }
  if (!acc?.apiKey) {
    console.error("app credential file has no apiKey");
    process.exit(1);
  }
  saveAccount({ apiKey: acc.apiKey, username: acc.username, isPro: acc.isPro });
}

export {
  exchangeCode,
  startLoginFlow,
  handleLoginCallback,
  completeLoginFromText,
  pendingStates,
  captureAfterLogin,
  login,
  importApp,
};
