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
//   426                               -> lane is not served (any body)
//   2xx / 401 / 403                   -> lane is served
//   0 (timeout) / 429 / 5xx           -> unknown, no lane signal
//
// A 200 from /theos also carries the authoritative lane_version, which is
// adopted verbatim when present.

const INSTANCE_ID = crypto.randomBytes(16).toString("hex");
// The gateway's "this build is retired" wording has changed before, and a 426
// is Upgrade Required either way. Match the known phrasings so a rename still
// triggers a re-discovery instead of looking like a served lane.
const VERSION_REJECTED =
  /lane_version_unsupported|no longer supported|update the app|unsupported (?:app )?version|version of deepai code/i;
const PROBE_TIMEOUT_MS = 10_000;
// Discovery probes anchors every ANCHOR_STEP lanes, then binary-searches the
// top of the served range. That recovers from a jump of any size, unlike a
// fixed up/down walk that only covers a handful of releases.
const ANCHOR_STEP = 8;
const PROBE_CONCURRENCY = 6;
// A failed app-version fetch retries after this long instead of the full TTL.
const APP_VERSION_RETRY_MS = 60_000;

let lane = Number.isFinite(LANE_VERSION) && LANE_VERSION > 0 ? LANE_VERSION : 6;
let laneSource = "seed";
let laneCheckedAt = 0;
let appVersion = APP_VERSION;
let appVersionSource = "seed";
let appVersionError = "";
let appVersionCheckedAt = 0;
let appVersionRefreshing = null;
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
    appVersionSource,
    appVersionError: appVersionError || null,
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

/** True when a response is the gateway's "this build is retired" refusal. */
async function isLaneRejection(res) {
  if (!res) return false;
  // 426 Upgrade Required is the gate's own status. Checking the body first
  // would make a renamed marker look like a served lane.
  if (res.status === 426) return true;
  if (res.status !== 400 && res.status !== 403) return false;
  try {
    return VERSION_REJECTED.test(await res.clone().text());
  } catch {
    return false;
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

/**
 * What one probe result says about the lane.
 *
 * Only a 426 says "not served". A 2xx/401/403 says "served" (the gate runs
 * before the credential check, so an auth error means the lane passed), but a
 * 2xx only counts when the body is the expected JSON: a captive portal or a
 * challenge page also answers 200. A timeout, 429 or 5xx is "unknown":
 * adopting it would pin a lane nobody confirmed, and calling it refused would
 * hide a served lane.
 */
function kindOf(status, rejected, jsonOk) {
  if (rejected) return "rejected";
  if (status === 401 || status === 403) return "served";
  if (status >= 200 && status < 300) return jsonOk ? "served" : "unknown";
  return "unknown";
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
    const rejected = res.status === 426;
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {}
    let serverLane = null;
    if (!rejected && typeof data?.lane_version === "number" && Number.isFinite(data.lane_version)) {
      serverLane = data.lane_version;
    }
    return {
      lane: laneValue,
      status: res.status,
      rejected,
      kind: kindOf(res.status, rejected, data !== null),
      serverLane,
      detail: body.slice(0, 120).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      lane: laneValue,
      status: 0,
      rejected: false,
      kind: "unknown",
      serverLane: null,
      error: String(err?.message || err),
    };
  }
}

function adopt(next, source) {
  const changed = next !== lane;
  const wasSeed = laneSource === "seed";
  lane = next;
  laneSource = source;
  laneCheckedAt = Date.now();
  lastError = "";
  if (changed) console.error(`lane: using ${next} (was ${wasSeed ? "seed" : "older"}, source: ${source})`);
  return laneInfo();
}

/**
 * Find the newest served lane.
 *
 * The served set is a contiguous range, but the seed can sit anywhere relative
 * to it (too old, too new, or inside). Two passes avoid a long sequential walk:
 *
 *   1. probe anchors spread across 1..LANE_MAX in parallel;
 *   2. binary-search the boundary between the highest served anchor and the
 *      lowest refused anchor above it.
 *
 * A lane jump of any size therefore resolves in ~12 probes, and a run of
 * "unknown" answers (timeout, 429, 5xx) never masquerades as a served lane.
 */
async function discover(signal) {
  const cache = new Map();
  const check = (value) => {
    if (!cache.has(value)) cache.set(value, probe(value, signal));
    return cache.get(value);
  };
  const probeAll = async (values) => {
    const out = [];
    for (let i = 0; i < values.length; i += PROBE_CONCURRENCY) {
      out.push(...(await Promise.all(values.slice(i, i + PROBE_CONCURRENCY).map(check))));
    }
    return out;
  };
  const fromServer = (results) => {
    const hit = results.find((r) => r.serverLane);
    return hit ? adopt(hit.serverLane, "server") : null;
  };
  const unreachable = (results) =>
    results.find((r) => r.error)?.error || "no lane signal from the gateway";

  const anchors = [lane];
  for (let value = 1; value <= LANE_MAX; value += ANCHOR_STEP) anchors.push(value);
  if (anchors[anchors.length - 1] !== LANE_MAX) anchors.push(LANE_MAX);

  let results = await probeAll([...new Set(anchors)].filter((value) => value >= 1 && value <= LANE_MAX));
  let known = results.filter((r) => r.kind !== "unknown");
  if (!known.length) throw new Error(unreachable(results));
  const authoritative = fromServer(results);
  if (authoritative) return authoritative;

  let served = known.filter((r) => r.kind === "served").map((r) => r.lane);
  let refused = known.filter((r) => r.kind === "rejected").map((r) => r.lane);

  if (!served.length) {
    // The served range is narrower than the anchor spacing, so no anchor
    // landed inside it. Scan every lane once; this is rare and still bounded.
    results = await probeAll(Array.from({ length: LANE_MAX }, (_, i) => i + 1));
    known = results.filter((r) => r.kind !== "unknown");
    if (!known.length) throw new Error(unreachable(results));
    const scanServer = fromServer(results);
    if (scanServer) return scanServer;
    served = known.filter((r) => r.kind === "served").map((r) => r.lane);
    refused = known.filter((r) => r.kind === "rejected").map((r) => r.lane);
    if (!served.length) throw new Error("no served lane found between 1 and " + LANE_MAX);
  }

  let lo = Math.max(...served);
  let hi = Math.min(LANE_MAX + 1, ...refused.filter((value) => value > lo));
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const next = await check(mid);
    if (next.serverLane) return adopt(next.serverLane, "server");
    if (next.kind === "served") lo = mid;
    else if (next.kind === "rejected") hi = mid;
    else break; // unknown: keep the last lane a probe confirmed
  }
  return adopt(lo, "probe");
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

/**
 * Fetch the current desktop release from the download redirect (0.3.38, ...).
 *
 * The timestamp is only advanced on success: a failed fetch retries after a
 * minute instead of pinning the fallback version for the full TTL.
 */
function refreshAppVersion({ force = false } = {}) {
  if (!force && appVersionCheckedAt && Date.now() - appVersionCheckedAt < APP_VERSION_TTL_MS) {
    return Promise.resolve(appVersion);
  }
  if (appVersionRefreshing) return appVersionRefreshing;

  const run = (async () => {
    try {
      const res = await fetch(DOWNLOAD_PROBE_URL, {
        method: "HEAD",
        redirect: "follow",
        headers: { "user-agent": "deepai-proxy" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error("download redirect answered " + res.status);
      const match = /DeepAI-Code-(\d+\.\d+\.\d+)-/.exec(res.url || "");
      if (!match) throw new Error("no release version in " + (res.url || "(empty url)"));
      if (match[1] !== appVersion) {
        console.error(`version: app ${appVersion} -> ${match[1]} (from download redirect)`);
      }
      appVersion = match[1];
      appVersionSource = "download";
      appVersionError = "";
      appVersionCheckedAt = Date.now();
    } catch (err) {
      appVersionError = String(err?.message || err);
      // Retry soon: now - checkedAt reaches the TTL again after ~1 minute.
      appVersionCheckedAt = Date.now() - APP_VERSION_TTL_MS + APP_VERSION_RETRY_MS;
      console.error(
        `version: app fetch failed (${appVersionError}), keeping ${appVersion} (${appVersionSource})`,
      );
    }
    return appVersion;
  })();
  appVersionRefreshing = run;
  run.finally(() => {
    if (appVersionRefreshing === run) appVersionRefreshing = null;
  });
  return run;
}

/** Startup warm-up: learn the lane and the app version before the first request. */
async function warm() {
  await Promise.all([refreshLane({ force: true }).catch(() => {}), refreshAppVersion().catch(() => {})]);
  return laneInfo();
}

/**
 * Keep the lane and the app version current for the life of the process.
 *
 * Requests already refresh the lane lazily, but nothing else re-fetches the
 * app version, so without this timer a long-running container would keep the
 * version it saw at boot. Both calls are no-ops inside their TTL.
 */
function startVersionWatch(intervalMs = 60_000) {
  const timer = setInterval(() => {
    refreshLane().catch(() => {});
    refreshAppVersion().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
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
  startVersionWatch,
  warm,
};
