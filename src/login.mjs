import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { API_ORIGIN, MODEL_BASE, APP_ACCOUNT_BIN } from "./config.mjs";
import { saveAccount } from "./account.mjs";

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

export { exchangeCode, login, importApp };
