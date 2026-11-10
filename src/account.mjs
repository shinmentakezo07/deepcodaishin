import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ACC_PATH, ACCOUNTS_PATH, APP_USERDATA, APP_ACCOUNT_BIN } from "./config.mjs";

// ---------------------------------------------------------------- store
//
// One JSON store, two accepted shapes:
//
//   { active, apiKey, username, isPro,
//     settings: { rotation: "round-robin" | "single", active },
//     accounts: [ { name, apiKey, username, isPro, weight, machineId?, affinity? } ] }
//
// A bare account object or a bare accounts array is also read. The top-level
// apiKey mirrors the active account so a reader that predates the accounts
// array still finds a credential.

const DEFAULT_SETTINGS = { rotation: "round-robin", active: "", sendMachineHeader: false };
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 20;
const MAX_RING = 2000;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME_RE = /^[^\r\n\t]{1,64}$/;

function validAccount(acc) {
  return !!acc && typeof acc.apiKey === "string" && !!acc.apiKey && !/[\r\n]/.test(acc.apiKey);
}

function cleanWeight(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return MIN_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function cleanName(value) {
  const s = String(value == null ? "" : value).trim();
  return NAME_RE.test(s) ? s : "";
}

function cleanSettings(raw) {
  const rotation = raw && raw.rotation === "single" ? "single" : "round-robin";
  return {
    rotation,
    active: cleanName(raw && raw.active),
    sendMachineHeader: raw ? raw.sendMachineHeader === true : false,
  };
}

function cleanAccount(acc, fallbackName) {
  return {
    name: cleanName(acc.name) || fallbackName,
    apiKey: acc.apiKey,
    username: typeof acc.username === "string" ? acc.username : "",
    isPro: acc.isPro === true,
    weight: cleanWeight(acc.weight),
    machineId: typeof acc.machineId === "string" && acc.machineId ? acc.machineId : undefined,
    affinity: typeof acc.affinity === "string" && acc.affinity ? acc.affinity : undefined,
  };
}

function storePath() {
  return fs.existsSync(ACCOUNTS_PATH) ? ACCOUNTS_PATH : ACC_PATH;
}

function readRaw() {
  for (const p of [ACCOUNTS_PATH, ACC_PATH]) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && typeof raw === "object") return raw;
    } catch {}
  }
  return null;
}

function uniqueName(list, wanted, apiKey) {
  const base = cleanName(wanted) || "account";
  const taken = (name, ignoreIndex) =>
    list.some((a, i) => i !== ignoreIndex && a.name === name && a.apiKey !== apiKey);
  if (!taken(base, -1)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = base + "-" + n;
    if (!taken(candidate, -1)) return candidate;
  }
  return base + "-" + crypto.randomBytes(3).toString("hex");
}

function normalize(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  let list = [];
  if (!raw) {
    return { accounts: [], settings };
  }
  if (Array.isArray(raw)) {
    list = raw;
  } else if (Array.isArray(raw.accounts)) {
    list = raw.accounts;
    Object.assign(settings, cleanSettings(raw.settings || { active: raw.active }));
  } else if (validAccount(raw)) {
    list = [raw];
  }

  const accounts = [];
  for (const item of list) {
    if (!validAccount(item)) continue;
    const fallback = cleanName(item.username) || "account-" + (accounts.length + 1);
    const clean = cleanAccount(item, fallback);
    clean.name = uniqueName(accounts, clean.name, clean.apiKey);
    const existing = accounts.findIndex((a) => a.apiKey === clean.apiKey);
    if (existing === -1) accounts.push(clean);
    else accounts[existing] = clean;
  }

  if (!settings.active) {
    const declared = cleanName(raw && (raw.active || (raw.settings && raw.settings.active)));
    settings.active = declared && accounts.some((a) => a.name === declared)
      ? declared
      : (accounts[0] ? accounts[0].name : "");
  }
  return { accounts, settings };
}

let namesMigrated = false;

function loadStore() {
  const raw = readRaw();
  const store = normalize(raw);
  // Persist derived names once, so a later reorder cannot rename an account.
  if (!namesMigrated) {
    namesMigrated = true;
    const needs = Array.isArray(raw && raw.accounts) &&
      raw.accounts.some((a) => a && validAccount(a) && !cleanName(a.name));
    if (needs) {
      try {
        saveStore({ accounts: store.accounts, settings: store.settings });
      } catch {}
    }
  }
  return store;
}

function loadAccounts() {
  return loadStore().accounts;
}

function loadSettings() {
  return loadStore().settings;
}

function saveStore(store) {
  revision += 1;
  const accounts = store.accounts.filter(validAccount).map((a) => cleanAccount(a, "account"));
  const settings = cleanSettings(store.settings);
  const target = storePath();

  if (accounts.length === 0) {
    fs.rmSync(target, { force: true });
    if (target === ACCOUNTS_PATH) fs.rmSync(ACC_PATH, { force: true });
    resetRotation();
    return { accounts: [], settings };
  }

  const active = accounts.find((a) => a.name === settings.active) || accounts[0];
  const payload = {
    active: active.name,
    apiKey: active.apiKey,
    username: active.username,
    isPro: active.isPro,
    settings: { ...settings, active: active.name },
    accounts,
  };
  writeJson(target, payload);
  if (target === ACCOUNTS_PATH) {
    // Keep the legacy single-account path readable.
    writeJson(ACC_PATH, { apiKey: active.apiKey, username: active.username, isPro: active.isPro });
  }
  return { accounts, settings: payload.settings };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function saveAccounts(accounts) {
  return saveStore({ accounts, settings: loadSettings() }).accounts;
}

function saveSettings(patch) {
  const store = loadStore();
  const next = cleanSettings({ ...store.settings, ...patch });
  const saved = saveStore({ accounts: store.accounts, settings: next });
  return saved.settings;
}

// ---------------------------------------------------------------- views

function maskKey(key) {
  if (!key || key.length <= 12) return "****";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

function listAccountSummaries() {
  const store = loadStore();
  const single = store.settings.rotation === "single";
  return store.accounts.map((a, index) => ({
    index,
    name: a.name,
    username: a.username,
    isPro: a.isPro,
    weight: a.weight,
    machineId: accountMachineId(a, null).slice(0, 12),
    maskedKey: maskKey(a.apiKey),
    active: single ? a.name === store.settings.active : true,
  }));
}

function listAccounts() {
  const store = loadStore();
  return store.accounts.map((a) => ({ ...a, active: a.name === store.settings.active }));
}

function findAccount(name) {
  const store = loadStore();
  if (store.accounts.length === 0) return null;
  if (!name) return store.accounts.find((a) => a.name === store.settings.active) || store.accounts[0];
  return store.accounts.find((a) => a.name === name) || null;
}

function setActive(name) {
  const store = loadStore();
  if (!store.accounts.some((a) => a.name === name)) return false;
  saveStore({ accounts: store.accounts, settings: { ...store.settings, active: name } });
  return true;
}

// ---------------------------------------------------------------- machine + affinity

/**
 * Digest this account presents as its machine.
 *   undefined      -> sha256("deepai-proxy:" + name)  (stable, distinct per account)
 *   "local"        -> the real digest of this computer
 *   64 hex chars   -> used verbatim
 *   any other text -> sha256(text)
 */
function accountMachineId(account, localDigest) {
  const raw = account && account.machineId;
  if (raw === "local") return localDigest || null;
  if (raw && HEX64.test(raw)) return raw;
  if (raw) return crypto.createHash("sha256").update(raw).digest("hex");
  const seed = "deepai-proxy:" + ((account && account.name) || "default");
  return crypto.createHash("sha256").update(seed).digest("hex");
}

/** UUID-shaped affinity so session stickiness survives a restart. */
function accountAffinity(account) {
  if (account && account.affinity) return account.affinity;
  const seed = "deepai-proxy-affinity:" + ((account && account.name) || "default") + ":" + ((account && account.apiKey) || "");
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}

// ---------------------------------------------------------------- mutations

function addAccount(acc) {
  if (!validAccount(acc)) throw Object.assign(new Error("invalid account"), { status: 400 });
  const store = loadStore();
  const list = store.accounts;
  const existing = list.findIndex((x) => x.apiKey === acc.apiKey);
  let added = false;
  let record;

  if (existing === -1) {
    record = cleanAccount(acc, acc.username || "account-" + (list.length + 1));
    record.name = uniqueName(list, record.name, record.apiKey);
    list.push(record);
    added = true;
  } else {
    const current = list[existing];
    record = {
      ...current,
      username: typeof acc.username === "string" && acc.username ? acc.username : current.username,
      isPro: acc.isPro === undefined ? current.isPro : acc.isPro === true,
      weight: acc.weight === undefined ? current.weight : cleanWeight(acc.weight),
      machineId: typeof acc.machineId === "string" ? acc.machineId || undefined : current.machineId,
      affinity: typeof acc.affinity === "string" ? acc.affinity || undefined : current.affinity,
      name: cleanName(acc.name) && cleanName(acc.name) !== current.name
        ? uniqueName(list, acc.name, acc.apiKey)
        : current.name,
    };
    list[existing] = record;
  }

  const settings = { ...store.settings };
  if (!settings.active) settings.active = record.name;
  saveStore({ accounts: list, settings });
  return { account: record, added, total: list.length, index: existing === -1 ? list.length - 1 : existing };
}

function updateAccount(index, patch) {
  const store = loadStore();
  const list = store.accounts;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const current = list[index];
  const next = { ...current };
  if (patch.weight !== undefined) next.weight = cleanWeight(patch.weight);
  if (typeof patch.username === "string") next.username = patch.username;
  if (patch.name !== undefined) {
    const wanted = cleanName(patch.name);
    if (wanted && wanted !== current.name) {
      next.name = uniqueName(list, wanted, current.apiKey);
      if (store.settings.active === current.name) store.settings.active = next.name;
    }
  }
  if (patch.machineId !== undefined) {
    next.machineId = typeof patch.machineId === "string" && patch.machineId ? patch.machineId : undefined;
  }
  if (patch.affinity !== undefined) {
    next.affinity = typeof patch.affinity === "string" && patch.affinity ? patch.affinity : undefined;
  }
  list[index] = next;
  saveStore({ accounts: list, settings: store.settings });
  return next;
}

function removeAccountAt(index) {
  const store = loadStore();
  const list = store.accounts;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const removed = list.splice(index, 1)[0];
  if (store.settings.active === removed.name) {
    store.settings.active = list[0] ? list[0].name : "";
  }
  saveStore({ accounts: list, settings: store.settings });
  return removed;
}

function clearAccounts() {
  saveStore({ accounts: [], settings: loadSettings() });
}

function requireAccount(name) {
  const acc = findAccount(name);
  if (!acc) {
    console.error(name ? "no account named " + name : "no credential stored");
    console.error("run: node deepai-proxy.mjs login   (or import-app)");
    process.exit(1);
  }
  return acc;
}

function loadAccount() {
  return findAccount();
}

function saveAccount(acc, name) {
  const result = addAccount(name ? { ...acc, name } : acc);
  console.log(
    "saved " + result.account.name + " -> " + storePath() +
      " (user=" + (acc.username || "?") + ", pro=" + (acc.isPro === true) + ", total=" + result.total + ")",
  );
  return result;
}

// ---------------------------------------------------------------- revision

let revision = 0;

function accountsRevision() {
  return revision;
}

// ---------------------------------------------------------------- rotation

let ring = [];
let ringSignature = "";
let cursor = 0;

function buildRing(list) {
  const signature = list.map((a) => a.name + ":" + a.weight).join("|");
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
 * Next account for a request. "single" pins to the active account; otherwise a
 * weighted ring decides the order.
 */
function nextAccount() {
  const store = loadStore();
  const list = store.accounts;
  if (list.length === 0) {
    resetRotation();
    return null;
  }
  if (store.settings.rotation === "single") {
    const index = Math.max(0, list.findIndex((a) => a.name === store.settings.active));
    return { ...list[index], index };
  }
  const schedule = buildRing(list);
  if (schedule.length === 0) return { ...list[0], index: 0 };
  const index = schedule[cursor % schedule.length];
  cursor = (cursor + 1) % schedule.length;
  return { ...list[index], index };
}

function rotationState() {
  const store = loadStore();
  const list = store.accounts;
  const schedule = store.settings.rotation === "single" ? [0] : buildRing(list);
  const nextIndex = schedule.length ? schedule[cursor % schedule.length] : 0;
  return {
    total: list.length,
    mode: store.settings.rotation,
    active: store.settings.active,
    nextIndex,
    nextName: list[nextIndex] ? list[nextIndex].name : null,
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
  storePath,
  maskKey,
  loadStore,
  loadAccounts,
  loadSettings,
  saveStore,
  saveAccounts,
  saveSettings,
  listAccounts,
  listAccountSummaries,
  findAccount,
  setActive,
  addAccount,
  updateAccount,
  removeAccountAt,
  clearAccounts,
  loadAccount,
  saveAccount,
  requireAccount,
  accountCount,
  accountsRevision,
  accountMachineId,
  accountAffinity,
  nextAccount,
  rotationState,
  resetRotation,
  findAppAccounts,
  captureAppAccounts,
};
