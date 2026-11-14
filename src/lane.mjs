import crypto from "node:crypto";
import {
  MODEL_BASE,
  LANE_VERSION,
  LANE_AUTODISCOVER,
  LANE_REFRESH_MS,
  LANE_MAX,
  APP_VERSION,
  APP_VERSION_TTL_MS,
  DOWNLOAD_PROBE_URL,
} from "./config.mjs";
import { listAccounts } from "./account.mjs";

// ---------------------------------------------------------------- lane gate
//
// The gateway refuses a build whose lane sits outside the range it currently
// serves:
//
//   426 {"error":{"type":"lane_version_unsupported",
//                 "message":"This version of DeepAI Code is no longer supported."}}
//
// The lane is the number the desktop app ships in X-DeepAI-Code-Theos, so it
// changes every time DeepAI retires a release. Hardcoding it means the proxy
// breaks the day the app is bumped, so this module discovers the accepted lane
// from the gateway and keeps it fresh inside the running process: no restart
// and no code change.
//
// The gate is evaluated before the credential check, so a probe needs nothing
// but the lane header:
//
//   426 + lane_version_unsupported  -> lane is not served
//   anything else (200/401/403...)  -> lane is served
//
// A 200 from /theos also carries the authoritative lane_version, which is
// adopted verbatim when present.

const INSTANCE_ID = crypto.randomBytes(16).toString("hex");
const LANE_REJECTED = /lane_version_unsupported/;
const PROBE_TIMEOUT_MS = 10_000;
// How far the discovery walk looks above/below the lane it already has.
const WALK_UP = 4;
const WALK_DOWN = 12;

let lane = Number.isFinite(LANE_VERSION) && LANE_VERSION > 0 ? LANE_VERSION : 6;
let laneSource = "seed";
let laneCheckedAt = 0;
let appVersion = APP_VERSION;
let appVersionCheckedAt = 0;
let refresh = null;
let lastError = "";

/** The lane the next request will present. Always current, never stale by design. */
function currentLane() {
  return lane;
}

function currentAppVersion() {
  return appVersion;
}

function laneInfo() {
  return {
    version: lane,
    source: laneSource,
    appVersion,
    autoDiscover: LANE_AUTODISCOVER,
    checkedAt: laneCheckedAt ? new Date(laneCheckedAt).toISOString() : null,
    ageSeconds: laneCheckedAt ? Math.round((Date.now() - laneCheckedAt) / 1000) : null,
    refreshSeconds: Math.round(LANE_REFRESH_MS / 1000),
    lastError: lastError || null,
  };
}

/** The check-in beacon the app attaches to /theos: v=<ver>;up=<uptime>;pi;focus. */
function beaconHeader() {
  return `v=${appVersion};up=${Math.floor(process.uptime())};pi=0;focus=0`;
}

/** True when a response is the gateway's "update the app" refusal. */
async function isLaneRejection(res) {
  if (!res || res.status !== 426) return false;
  try {
    const text = await res.clone().text();
    return LANE_REJECTED.test(text);
  } catch {
    return true;
  }
}

/** Remember that the current lane was refused, so the next refresh re-discovers. */
function noteLaneRejected() {
  laneCheckedAt = 0;
  laneSource = "rejected";
}

function probeAccount() {
  try {
    const accounts = listAccounts();
    return accounts.find((a) => a.active) || accounts[0] || null;
  } catch {
    return null;
  }
}

/** One /theos call at one lane. Never throws: a transport error is "unknown". */
async function probe(laneValue, signal) {
  const headers = {
    "Content-Type": "application/json",
    "X-DeepAI-Code-Theos": String(laneValue),
    "X-DeepAI-Code-Instance": INSTANCE_ID,
    "X-DeepAI-Code-Beacon": beaconHeader(),
  };
  const account = probeAccount();
  if (account && account.apiKey) headers["api-key"] = account.apiKey;

  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const deadline =
    signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal || timeout;
  try {
    const res = await fetch(MODEL_BASE + "/theos", { method: "GET", headers, redirect: "error", signal: deadline });
    const body = await res.text().catch(() => "");
    const rejected = res.status === 426 && LANE_REJECTED.test(body);
    let serverLane = null;
    if (!rejected) {
      try {
        const data = JSON.parse(body);
        if (typeof data?.lane_version === "number" && Number.isFinite(data.lane_version)) serverLane = data.lane_version;
      } catch {}
    }
    return { lane: laneValue, status: res.status, rejected, serverLane, detail: body.slice(0, 120).replace(/\s+/g, " ") };
  } catch (err) {
    return { lane: laneValue, status: 0, rejected: false, serverLane: null, error: String(err?.message || err) };
  }
}

function adopt(next, source) {
  const changed = next !== lane;
  lane = next;
  laneSource = source;
  laneCheckedAt = Date.now();
  lastError = "";
  if (changed) console.error(`lane: using ${next} (was ${laneSource === "seed" ? "seed" : "older"}, source: ${source})`);
  return laneInfo();
}

/**
 * Walk the lane space until the newest served lane is found.
 *
 * The served set is a contiguous range, so:
 *   - a served lane climbs upward until the first refusal;
 *   - a refused lane walks up first (covers "too old"), then down (covers
 *     "too new"), and the first served lane found on the way down is the top.
 */
async function discover(signal) {
  const cache = new Map();
  const check = (value) => {
    if (!cache.has(value)) cache.set(value, probe(value, signal));
    return cache.get(value);
  };

  const start = lane;
  const first = await check(start);
  if (first.error && first.status === 0) throw new Error(first.error);
  if (first.serverLane) return adopt(first.serverLane, "server");
  if (!first.rejected) return climb(start);

  for (let value = start + 1; value <= Math.min(start + WALK_UP, LANE_MAX); value += 1) {
    const next = await check(value);
    if (next.serverLane) return adopt(next.serverLane, "server");
    if (!next.rejected) return climb(value);
  }
  for (let value = start - 1; value >= Math.max(1, start - WALK_DOWN); value -= 1) {
    const next = await check(value);
    if (next.serverLane) return adopt(next.serverLane, "server");
    if (!next.rejected) return adopt(value, "probe");
  }
  throw new Error("no served lane found between 1 and " + LANE_MAX);

  async function climb(from) {
    let best = from;
    for (let value = from + 1; value <= Math.min(from + WALK_UP, LANE_MAX); value += 1) {
      const next = await check(value);
      if (next.serverLane) return adopt(next.serverLane, "server");
      if (next.rejected) break;
      best = value;
    }
    return adopt(best, "probe");
  }
}

/**
 * Refresh the lane, at most once per LANE_REFRESH_MS unless forced.
 *
 * Single-flight: concurrent callers (a burst of 426s) share one probe run. A
 * failure keeps the current lane and backs off instead of throwing, so a
 * flaky network never takes requests down.
 */
function refreshLane({ force = false, signal } = {}) {
  if (!LANE_AUTODISCOVER) return Promise.resolve(laneInfo());
  if (!force && laneCheckedAt && Date.now() - laneCheckedAt < LANE_REFRESH_MS) return Promise.resolve(laneInfo());
  if (refresh) return refresh;

  const run = (async () => {
    try {
      return await discover(signal);
    } catch (err) {
      lastError = String(err?.message || err);
      // Retry sooner than the full TTL, but not in a tight loop.
      laneCheckedAt = Date.now() - LANE_REFRESH_MS + 60_000;
      console.error("lane: discovery failed (" + lastError + "), keeping " + lane);
      return laneInfo();
    }
  })();
  refresh = run;
  run.finally(() => {
    if (refresh === run) refresh = null;
  });
  return run;
}

/** Fire-and-forget refresh when the cached lane is old; never blocks a request. */
function ensureLaneSoon() {
  if (!LANE_AUTODISCOVER) return;
  if (laneCheckedAt && Date.now() - laneCheckedAt < LANE_REFRESH_MS) return;
  refreshLane().catch(() => {});
}

/** Fetch the current desktop release from the download redirect (0.3.37, ...). */
async function refreshAppVersion() {
  if (appVersionCheckedAt && Date.now() - appVersionCheckedAt < APP_VERSION_TTL_MS) return appVersion;
  appVersionCheckedAt = Date.now();
  try {
    const res = await fetch(DOWNLOAD_PROBE_URL, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "deepai-proxy" },
      signal: AbortSignal.timeout(10_000),
    });
    const match = /DeepAI-Code-(\d+\.\d+\.\d+)-/.exec(res.url || "");
    if (match) appVersion = match[1];
  } catch {}
  return appVersion;
}

/** Startup warm-up: learn the lane and the app version before the first request. */
async function warm() {
  await Promise.all([refreshLane({ force: true }).catch(() => {}), refreshAppVersion().catch(() => {})]);
  return laneInfo();
}

export {
  currentLane,
  currentAppVersion,
  laneInfo,
  beaconHeader,
  isLaneRejection,
  noteLaneRejected,
  refreshLane,
  refreshAppVersion,
  ensureLaneSoon,
  warm,
};
