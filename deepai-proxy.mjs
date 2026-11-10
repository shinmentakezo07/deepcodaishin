#!/usr/bin/env node
/**
 * deepai-proxy.mjs — local gateway for a DeepAI Code (desktop) account.
 *
 * Speaks the same wire protocol as the app:
 *   sign-in : GET  https://api.deepai.org/deepai_code/desktop_auth/?state=..&port=..
 *             GET  http://127.0.0.1:<port>/auth-callback?code=..&state=..
 *             POST https://api.deepai.org/deepai_code/desktop_auth/exchange/   {code}
 *   chat    : POST https://api.deepai.org/deepai_code/chat/completions
 *   responses:POST https://api.deepai.org/deepai_code/responses
 *
 * Exposes locally:
 *   POST /v1/chat/completions   OpenAI Chat Completions (native upstream format)
 *   POST /v1/messages           Anthropic Messages (translated to/from OpenAI)
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models
 *   GET  /health
 *
 * Fingerprint headers sent upstream (mirrors the app):
 *   Content-Type: application/json
 *   X-DeepAI-Code-Theos: 4
 *   X-DeepAI-Code-Instance: <32 hex, per process>
 *   X-DeepAI-Code-Machine: sha256(machine uuid)
 *   api-key: <account api key>
 *   X-Session-Affinity: <optional, from request>
 *
 * Usage:
 *   node deepai-proxy.mjs login          # browser sign-in -> add account to acc.json
 *   node deepai-proxy.mjs import-app     # copy the desktop app's stored credential
 *   node deepai-proxy.mjs serve          # start proxy on 127.0.0.1:8787
 *   node deepai-proxy.mjs whoami
 *   PORT=9000 PROXY_TOKEN=secret node deepai-proxy.mjs serve
 */

import { MACHINE_HEADER } from "./src/fingerprint.mjs";
import { loadAccounts, maskKey, rotationState } from "./src/account.mjs";
import { login, importApp } from "./src/login.mjs";
import { startServer } from "./src/http-server.mjs";

// ---------------------------------------------------------------- main

const cmd = process.argv[2] || "serve";
if (cmd === "login") await login();
else if (cmd === "import-app") importApp();
else if (cmd === "whoami") {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.error("no credential stored — run login, import-app, or use the UI");
    process.exit(1);
  }
  console.log(JSON.stringify({
    accounts: accounts.map((a, index) => ({
      index,
      username: a.username,
      isPro: a.isPro,
      apiKey: maskKey(a.apiKey) + " (" + a.apiKey.length + " chars)",
    })),
    rotation: rotationState(),
    machineHeader: MACHINE_HEADER || "(unavailable)",
  }, null, 2));
} else if (cmd === "serve") startServer();
else {
  console.error("unknown command: " + cmd + "\ncommands: login | import-app | serve | whoami");
  process.exit(1);
}
