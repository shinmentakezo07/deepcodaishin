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
 *   node deepai-proxy.mjs login          # browser sign-in -> acc.json
 *   node deepai-proxy.mjs import-app     # copy the desktop app's stored credential
 *   node deepai-proxy.mjs serve          # start proxy on 127.0.0.1:8787
 *   node deepai-proxy.mjs whoami
 *   PORT=9000 PROXY_TOKEN=secret node deepai-proxy.mjs serve
 */

import { MACHINE_HEADER } from "./src/fingerprint.mjs";
import { requireAccount } from "./src/account.mjs";
import { login, importApp } from "./src/login.mjs";
import { startServer } from "./src/http-server.mjs";

// ---------------------------------------------------------------- main

const cmd = process.argv[2] || "serve";
if (cmd === "login") await login();
else if (cmd === "import-app") importApp();
else if (cmd === "whoami") {
  const a = requireAccount();
  console.log(JSON.stringify({ ...a, apiKey: `${a.apiKey.slice(0, 8)}…(${a.apiKey.length} chars)` }, null, 2));
  console.log(`machine header: ${MACHINE_HEADER || "(unavailable)"}`);
} else if (cmd === "serve") startServer();
else {
  console.error(`unknown command: ${cmd}\ncommands: login | import-app | serve | whoami`);
  process.exit(1);
}
