#!/usr/bin/env node
/**
 * deepai-proxy.mjs - local gateway for a DeepAI Code (desktop) account.
 *
 * Speaks the same wire protocol as the app:
 *   sign-in : GET  https://api.deepai.org/deepai_code/desktop_auth/?state=..&port=..
 *             GET  http://127.0.0.1:<port>/auth-callback?code=..&state=..
 *             POST https://api.deepai.org/deepai_code/desktop_auth/exchange/   {code}
 *   chat    : POST https://api.deepai.org/deepai_code/chat/completions
 *
 * Exposes locally:
 *   POST /v1/chat/completions   OpenAI Chat Completions (native upstream format)
 *   POST /v1/messages           Anthropic Messages (translated to/from OpenAI)
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models
 *   GET  /health
 *   GET  /                      control panel
 *
 * Fingerprint headers sent upstream (mirrors the app):
 *   Content-Type: application/json
 *   X-DeepAI-Code-Theos: 4
 *   X-DeepAI-Code-Instance: <32 hex, per process>
 *   X-DeepAI-Code-Machine: per-account digest (DEEPAI_MACHINE_HEADER=1)
 *   api-key: <account api key>
 *   X-Session-Affinity: per-account, stable across restarts
 *
 * Usage:
 *   node deepai-proxy.mjs login [name]        # browser sign-in -> add account
 *   node deepai-proxy.mjs import-app [name]   # copy the desktop app credential
 *   node deepai-proxy.mjs accounts            # list accounts + machine digests
 *   node deepai-proxy.mjs use <name>          # pin the active account
 *   node deepai-proxy.mjs verify [name]       # live fingerprint check
 *   node deepai-proxy.mjs lane                # show (and re-discover) the served lane
 *   node deepai-proxy.mjs whoami [name]
 *   node deepai-proxy.mjs serve               # start proxy on 127.0.0.1:8787
 */

import { ACCOUNTS_PATH, ACC_PATH } from "./src/config.mjs";
import {
  requireAccount,
  listAccounts,
  setActive,
  accountMachineId,
  storePath,
} from "./src/account.mjs";
import { MACHINE_HEADER, MACHINE_SOURCE } from "./src/fingerprint.mjs";
import { laneInfo, refreshLane, refreshAppVersion } from "./src/lane.mjs";
import { login, importApp } from "./src/login.mjs";
import { startServer } from "./src/http-server.mjs";
import { verify } from "./src/verify.mjs";

// ---------------------------------------------------------------- main

const [cmd = "serve", arg] = process.argv.slice(2);

if (cmd === "login") await login(arg || undefined);
else if (cmd === "import-app") importApp(arg || undefined);

else if (cmd === "accounts") {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("no accounts in " + ACCOUNTS_PATH + " or " + ACC_PATH);
  } else {
    console.log("store: " + storePath());
    for (const a of accounts) {
      const digest = accountMachineId(a, MACHINE_HEADER);
      console.log(
        (a.active ? "*" : " ") + " " + a.name.padEnd(14) + " " + String(a.username || "?").padEnd(16) +
          " pro=" + String(a.isPro).padEnd(5) + " weight=" + String(a.weight).padEnd(2) +
          " machine=" + digest.slice(0, 12) + "...",
      );
    }
  }
}

else if (cmd === "use") {
  if (!arg) {
    console.error("usage: node deepai-proxy.mjs use <name>");
    process.exit(1);
  }
  if (!setActive(arg)) {
    console.error('unknown account "' + arg + '"');
    process.exit(1);
  }
  console.log("active account -> " + arg);
}

else if (cmd === "verify") await verify(arg);

else if (cmd === "lane") {
  await refreshLane({ force: true });
  await refreshAppVersion();
  console.log(JSON.stringify(laneInfo(), null, 2));
}

else if (cmd === "whoami") {
  const a = requireAccount(arg);
  console.log(JSON.stringify({
    name: a.name,
    username: a.username,
    isPro: a.isPro,
    weight: a.weight,
    apiKey: a.apiKey.slice(0, 8) + "...(" + a.apiKey.length + " chars)",
    machineId: accountMachineId(a, MACHINE_HEADER),
  }, null, 2));
  console.log("local machine digest: " + (MACHINE_HEADER || "(unavailable)") + "  source: " + MACHINE_SOURCE);
  console.log("store               : " + storePath());
}

else if (cmd === "serve") startServer();

else {
  console.error("unknown command: " + cmd);
  console.error("commands: login [name] | import-app [name] | accounts | use <name> | verify [name] | lane | serve | whoami [name]");
  process.exit(1);
}
