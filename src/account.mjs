import fs from "node:fs";
import path from "node:path";
import { ACC_PATH, APP_USERDATA, APP_ACCOUNT_BIN } from "./config.mjs";

// ---------------------------------------------------------------- acc.json
//
// The store is a JSON object:
//   { "accounts": [ { apiKey, username, isPro, weight } ],
//     "settings": { "rotation": "round-robin" | "single" } }
// Legacy shapes (a bare account object, or a bare accounts array) are accepted.

const DEFAULT_SETTINGS = { rotation: "round-robin" };
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 20;
const MAX_RING = 2000;

function validAccount(acc) {
  return !!acc && typeof acc.apiKey === "string" && !!acc.apiKey && !/[\r\n]/.test(acc.apiKey);
}

function cleanWeight(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return MIN_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function cleanAccount(acc) {
  return {
    apiKey: acc.apiKey,
    username: typeof acc.username === "string" ? acc.username : "",
    isPro: acc.isPro === true,
    weight: cleanWeight(acc.weight),
  };
}

function cleanSettings(raw) {
  const rotation = raw && raw.rotation === "single" ? "single" : "round-robin";
  return { rotation };
}

function readStore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ACC_PATH, "utf8"));
  } catch {
    return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
  }
  if (!raw) return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
  if (Array.isArray(raw)) return { accounts: raw.filter(validAccount).map(cleanAccount), settings: { ...DEFAULT_SETTINGS } };
  if (Array.isArray(raw.accounts)) {
    return { accounts: raw.accounts.filter(validAccount).map(cleanAccount), settings: cleanSettings(raw.settings) };
  }
  if (validAccount(raw)) return { accounts: [cleanAccount(raw)], settings: { ...DEFAULT_SETTINGS } };
  return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
}

function loadAccounts() {
  return readStore().accounts;
}

function loadSettings() {
  return readStore().settings;
}

function saveStore(store) {
  revision += 1;
  const accounts = store.accounts.filter(validAccount).map(cleanAccount);
  const settings = cleanSettings(store.settings);
  if (accounts.length === 0) {
    fs.rmSync(ACC_PATH, { force: true });
    resetRotation();
    return { accounts: [], settings };
  }
  fs.writeFileSync(ACC_PATH, JSON.stringify({ accounts, settings }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(ACC_PATH, 0o600);
  } catch {}
  return { accounts, settings };
}

function saveAccounts(accounts) {
  return saveStore({ accounts, settings: loadSettings() }).accounts;
}

function saveSettings(patch) {
  const store = readStore();
  const next = cleanSettings({ ...store.settings, ...patch });
  saveStore({ accounts: store.accounts, settings: next });
  return next;
}

function maskKey(key) {
  if (key.length <= 12) return "****";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

function listAccountSummaries() {
  const settings = loadSettings();
  return loadAccounts().map((a, index) => ({
    index,
    username: a.username,
    isPro: a.isPro,
    weight: a.weight,
    maskedKey: maskKey(a.apiKey),
    active: settings.rotation === "single" ? index === 0 : true,
  }));
}

function addAccount(acc) {
  if (!validAccount(acc)) throw Object.assign(new Error("invalid account"), { status: 400 });
  const store = readStore();
  const list = store.accounts;
  const clean = cleanAccount(acc);
  const index = list.findIndex((x) => x.apiKey === clean.apiKey);
  let added = false;
  if (index === -1) {
    list.push(clean);
    added = true;
  } else {
    // Keep the existing weight when the caller did not provide one.
    list[index] = { ...clean, weight: acc.weight === undefined ? list[index].weight : clean.weight };
  }
  saveStore({ accounts: list, settings: store.settings });
  return { account: list[index === -1 ? list.length - 1 : index], added, total: list.length, index: index === -1 ? list.length - 1 : index };
}

function updateAccount(index, patch) {
  const store = readStore();
  const list = store.accounts;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const next = { ...list[index] };
  if (patch.weight !== undefined) next.weight = cleanWeight(patch.weight);
  if (typeof patch.username === "string") next.username = patch.username;
  list[index] = next;
  saveStore({ accounts: list, settings: store.settings });
  return next;
}

function removeAccountAt(index) {
  const store = readStore();
  const list = store.accounts;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const removed = list.splice(index, 1)[0];
  saveStore({ accounts: list, settings: store.settings });
  return removed;
}

function clearAccounts() {
  saveStore({ accounts: [], settings: loadSettings() });
}

function requireAccount() {
  const acc = loadAccount();
  if (!acc) {
    console.error("no credential at " + ACC_PATH);
    console.error("run: node " + path.basename(process.argv[1] || "deepai-proxy.mjs") + " login");
    process.exit(1);
  }
  return acc;
}

// Legacy helpers: the first account is the default for CLI/status views.
function loadAccount() {
  return loadAccounts()[0] || null;
}

function saveAccount(acc) {
  const result = addAccount(acc);
  console.log("saved " + ACC_PATH + " (user=" + (acc.username || "?") + ", pro=" + (acc.isPro === true) + ", total=" + result.total + ")");
  return result;
}

// ---------------------------------------------------------------- revision

let revision = 0;

/** Bumped on every store change; lets the UI detect a completed login. */
function accountsRevision() {
  return revision;
}

// ---------------------------------------------------------------- rotation

// The ring is a deterministic schedule: weight 2 / weight 1 gives A, B, A.
// Rebuilt whenever the account list or weights change.
let ring = [];
let ringSignature = "";
let cursor = 0;

function buildRing(list) {
  const signature = list.map((a) => a.apiKey.slice(-8) + ":" + a.weight).join("|");
  if (signature === ringSignature) return ring;
  const maxWeight = list.reduce((m, a) => Math.max(m, a.weight), 1);
  const next = [];
  for (let level = 0; level < maxWeight && next.length < MAX_RING; level += 1) {
    list.forEach((a, index) => {
      if (a.weight > level && next.length < MAX_RING) next.push(index);
    });
  }
  ring = next;
  ringSignature = signature;
  cursor = 0;
  return ring;
}

function accountCount() {
  return loadAccounts().length;
}

/**
 * Returns the next account. With rotation "single" only the first account is
 * used; otherwise a weighted ring decides the order.
 */
function nextAccount() {
  const store = readStore();
  const list = store.accounts;
  if (list.length === 0) {
    resetRotation();
    return null;
  }
  if (store.settings.rotation === "single") return { ...list[0], index: 0 };
  const schedule = buildRing(list);
  if (schedule.length === 0) return { ...list[0], index: 0 };
  const index = schedule[cursor % schedule.length];
  cursor = (cursor + 1) % schedule.length;
  return { ...list[index], index };
}

function rotationState() {
  const store = readStore();
  const list = store.accounts;
  const schedule = store.settings.rotation === "single" ? [0] : buildRing(list);
  const nextIndex = schedule.length ? schedule[cursor % schedule.length] : 0;
  return {
    total: list.length,
    mode: store.settings.rotation,
    nextIndex,
    order: schedule,
    totalWeight: list.reduce((sum, a) => sum + a.weight, 0),
  };
}

function resetRotation() {
  cursor = 0;
  ring = [];
  ringSignature = "";
}

// ---------------------------------------------------------------- auto capture

/**
 * Look for credentials the desktop app left on disk: its secrets file plus any
 * JSON file under the userdata folder that carries an apiKey.
 */
function findAppAccounts() {
  const found = [];
  const seen = new Set();
  const push = (acc, source) => {
    if (!validAccount(acc) || seen.has(acc.apiKey)) return;
    seen.add(acc.apiKey);
    found.push({ apiKey: acc.apiKey, username: acc.username, isPro: acc.isPro, source });
  };

  try {
    push(JSON.parse(fs.readFileSync(APP_ACCOUNT_BIN, "utf8")), path.basename(APP_ACCOUNT_BIN));
  } catch {}

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith(".json") || entry.name.endsWith(".bin")) {
        try {
          push(JSON.parse(fs.readFileSync(full, "utf8")), path.relative(APP_USERDATA, full));
        } catch {}
      }
    }
  };
  walk(APP_USERDATA, 0);
  return found;
}

/** Import every credential the desktop app left behind. */
function captureAppAccounts() {
  const found = findAppAccounts();
  let added = 0;
  let updated = 0;
  for (const item of found) {
    const result = addAccount({ apiKey: item.apiKey, username: item.username, isPro: item.isPro });
    if (result.added) added += 1;
    else updated += 1;
  }
  return { found: found.length, added, updated, sources: found.map((f) => f.source) };
}

export {
  MIN_WEIGHT,
  MAX_WEIGHT,
  maskKey,
  loadAccounts,
  loadSettings,
  saveAccounts,
  saveSettings,
  listAccountSummaries,
  addAccount,
  updateAccount,
  removeAccountAt,
  clearAccounts,
  loadAccount,
  saveAccount,
  requireAccount,
  accountCount,
  accountsRevision,
  nextAccount,
  rotationState,
  resetRotation,
  findAppAccounts,
  captureAppAccounts,
};
