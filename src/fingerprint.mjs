import crypto from "node:crypto";
import { accountAffinity, accountMachineId, machineHeaderEnabled } from "./account.mjs";
import { currentLane, userAgent } from "./lane.mjs";
import { MACHINE_HEADER, MACHINE_SOURCE, rawMachineUuid } from "./machine.mjs";

// ---------------------------------------------------------------- fingerprint

const INSTANCE_ID = crypto.randomBytes(16).toString("hex"); // per process, like the app

/** Last-resort affinity for a bare api key; stable for the process lifetime. */
const SESSION_AFFINITY = process.env.DEEPAI_SESSION_AFFINITY || crypto.randomUUID();

// Defaults every request carries. undici would otherwise send `user-agent:
// node`, `accept-language: *` and no br, none of which the desktop app sends.
const CLIENT_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

/**
 * Build the outgoing header set.
 *
 * The lane header is read from lane.mjs on every call, so a lane bump the
 * gateway announces mid-run is picked up by the next request.
 *
 * Accepts an account record (preferred) or a bare api key string. When an
 * account is given, the machine digest and affinity come from the record, so
 * two accounts never present the same machine unless configured to.
 */
function fingerprintHeaders(account, extra = {}, options = {}) {
  const isObject = account && typeof account === "object";
  const apiKey = isObject ? account.apiKey : String(account || "");
  const sendMachine = options.machine === undefined ? machineHeaderEnabled() : options.machine === true;

  const h = {
    "Content-Type": "application/json",
    "X-DeepAI-Code-Theos": String(currentLane()),
    "X-DeepAI-Code-Instance": INSTANCE_ID,
  };

  const machine = isObject ? accountMachineId(account, MACHINE_HEADER) : MACHINE_HEADER;
  if (machine && sendMachine) h["X-DeepAI-Code-Machine"] = machine;

  h["api-key"] = apiKey;

  const affinity =
    (extra && extra["X-Session-Affinity"]) ||
    (isObject ? accountAffinity(account) : "") ||
    SESSION_AFFINITY;
  if (affinity) h["X-Session-Affinity"] = affinity;

  // The app's bridge order ends with the key and affinity; the browser-like
  // defaults go after them so the custom header order stays the app's.
  h["User-Agent"] = userAgent();
  Object.assign(h, CLIENT_HEADERS);

  for (const [k, v] of Object.entries(extra)) {
    if (k === "X-Session-Affinity") continue;
    if (v === undefined || v === null || v === "") continue;
    h[k] = v;
  }
  return h;
}

export {
  INSTANCE_ID,
  MACHINE_HEADER,
  MACHINE_SOURCE,
  SESSION_AFFINITY,
  fingerprintHeaders,
  rawMachineUuid,
};
