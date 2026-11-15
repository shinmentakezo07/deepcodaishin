import crypto from "node:crypto";
import fs from "node:fs";
import { MODEL_BASE, MODELS_REFRESH_MS, APP_MODELS_JSON } from "./config.mjs";
import { listAccounts } from "./account.mjs";
import { currentLane } from "./lane.mjs";

// ---------------------------------------------------------------- catalog
//
// The model pool is discovered from the gateway's GET /models endpoint (the
// same list the desktop app renders) and refreshed in the background, so a
// model the gateway adds or retires shows up without a restart. Priority:
//
//   1. live gateway catalog (kept from the last successful fetch)
//   2. the app's generated models.json, when that file exists
//   3. FALLBACK_MODELS
//
// catalogIds() never blocks or throws: a fetch failure keeps the last good
// list and retries after a short backoff, exactly like lane discovery.

const FALLBACK_MODELS = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "glm-5.3",
  "kimi-k3",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gemini-4-argon",
  "claude-opus-5-5",
  "claude-fable-5-2",
  "qwen-3.8-flash",
  "qwen-3.8-max-prime",
  "mimo-2.6-flash",
  "mimo-2.6-pro",
  "minimax-m3",
  "minimax-m3.1-flash",
  "muse-spark-1.3",
  "muse-wonder",
  "solar-mini-4",
  "glyph-cluster",
  "crouton-alpha",
  "deepai-cyber",
  "gpt-6-astra",
];

// ---- live pool ----

const INSTANCE_ID = crypto.randomBytes(16).toString("hex");
const FETCH_TIMEOUT_MS = 10_000;
// After a failed fetch, retry this soon instead of waiting the full TTL.
const RETRY_AFTER_MS = 60_000;

let liveIds = null;
let liveFetchedAt = 0;
let liveRefreshing = null;
let liveError = "";

function poolAccount() {
  try {
    const accounts = listAccounts();
    return accounts.find((a) => a.active) || accounts[0] || null;
  } catch {
    return null;
  }
}

/** One GET /models call. Returns model ids, throws on any failure. */
async function fetchLive() {
  const headers = {
    "Content-Type": "application/json",
    "X-DeepAI-Code-Theos": String(currentLane()),
    "X-DeepAI-Code-Instance": INSTANCE_ID,
  };
  const account = poolAccount();
  if (account && account.apiKey) headers["api-key"] = account.apiKey;

  const res = await fetch(MODEL_BASE + "/models", {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("upstream /models answered " + res.status);
  const data = await res.json();
  const list = Array.isArray(data?.models) ? data.models : [];
  const ids = list
    .map((m) => (m && typeof m.id === "string" ? m.id.trim() : ""))
    .filter(Boolean);
  if (!ids.length) throw new Error("upstream /models returned no models");
  return ids;
}

/**
 * Refresh the pool, at most once per MODELS_REFRESH_MS unless forced.
 * Single-flight: concurrent callers share one fetch run. A failure keeps the
 * current list and backs off instead of throwing.
 */
function refreshModels({ force = false } = {}) {
  if (!force && liveFetchedAt && Date.now() - liveFetchedAt < MODELS_REFRESH_MS) {
    return Promise.resolve();
  }
  if (liveRefreshing) return liveRefreshing;

  const run = (async () => {
    try {
      const ids = await fetchLive();
      const changed = !liveIds || liveIds.join("\n") !== ids.join("\n");
      if (changed) {
        if (liveIds) console.error("models: pool updated, " + ids.length + " models");
        liveIds = ids;
      }
      liveFetchedAt = Date.now();
      liveError = "";
    } catch (err) {
      liveError = String(err?.message || err);
      liveFetchedAt = Date.now() - MODELS_REFRESH_MS + RETRY_AFTER_MS;
      console.error("models: pool refresh failed (" + liveError + "), keeping " +
        (liveIds ? "last live list" : "local fallback"));
    }
  })();
  liveRefreshing = run;
  run.finally(() => {
    if (liveRefreshing === run) liveRefreshing = null;
  });
  return run;
}

function modelsInfo() {
  return {
    source: liveIds ? "gateway" : "fallback",
    count: (liveIds || FALLBACK_MODELS).length,
    fetchedAt: liveFetchedAt ? new Date(liveFetchedAt).toISOString() : null,
    refreshSeconds: Math.round(MODELS_REFRESH_MS / 1000),
    lastError: liveError || null,
  };
}

// ---- local catalog (kept as the no-network fallback) ----

/** Model ids from the app's generated catalog, if present. */
let catalogCache = null;
let catalogMtime = 0;
function localCatalogIds() {
  let mtime = 0;
  try { mtime = fs.statSync(APP_MODELS_JSON).mtimeMs; } catch {}
  if (catalogCache && catalogMtime === mtime) return catalogCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(APP_MODELS_JSON, "utf8"));
    const list = cfg?.providers?.deepai?.models;
    if (Array.isArray(list) && list.length) {
      catalogCache = list.map((m) => m.id);
      catalogMtime = mtime;
      return catalogCache;
    }
  } catch {}
  catalogCache = FALLBACK_MODELS;
  catalogMtime = mtime;
  return catalogCache;
}

/** The ids /v1/models serves right now: live pool, else local catalog. */
function catalogIds() {
  void refreshModels();
  if (liveIds) return liveIds;
  return localCatalogIds();
}

export { FALLBACK_MODELS, catalogIds, refreshModels, modelsInfo };
