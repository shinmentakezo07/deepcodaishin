import fs from "node:fs";
import path from "node:path";
import { ACC_PATH } from "./config.mjs";

// ---------------------------------------------------------------- acc.json

function loadAccount() {
  try {
    const acc = JSON.parse(fs.readFileSync(ACC_PATH, "utf8"));
    if (!acc || typeof acc.apiKey !== "string" || !acc.apiKey) return null;
    return acc;
  } catch {
    return null;
  }
}

function saveAccount(acc) {
  const body = JSON.stringify(
    { apiKey: acc.apiKey, username: acc.username ?? "", isPro: acc.isPro === true },
    null,
    2,
  );
  fs.writeFileSync(ACC_PATH, body, { mode: 0o600 });
  try {
    fs.chmodSync(ACC_PATH, 0o600);
  } catch {}
  console.log(`saved ${ACC_PATH} (user=${acc.username || "?"}, pro=${acc.isPro === true})`);
}

function requireAccount() {
  const acc = loadAccount();
  if (!acc) {
    console.error(`no credential at ${ACC_PATH}`);
    console.error(`run: node ${path.basename(process.argv[1] || "deepai-proxy.mjs")} login`);
    process.exit(1);
  }
  return acc;
}

export { loadAccount, saveAccount, requireAccount };
