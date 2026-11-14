/**
 * verify - proves the proxy's fingerprint is accepted exactly as the app's is.
 *
 *   1. prints the outgoing header set (credential masked)
 *   2. calls the account endpoint the app uses for check-in  (GET  /deepai_code/theos)
 *   3. sends one minimal streamed chat request                (POST /deepai_code/chat/completions)
 *
 * The chat runs twice, with and without the account's machine digest, so a
 * rejected digest can be told apart from a rejected payload.
 */

import { MODEL_BASE, ACCOUNT_NAME } from "./config.mjs";
import { findAccount, listAccounts, accountMachineId, accountAffinity } from "./account.mjs";
import { fingerprintHeaders, MACHINE_HEADER, MACHINE_SOURCE } from "./fingerprint.mjs";
import { beaconHeader, laneInfo, refreshLane } from "./lane.mjs";

const PROBE_MODEL = process.env.VERIFY_MODEL || "deepseek-v4.1-flash";

function mask(headers, apiKey) {
  const safe = { ...headers };
  if (safe["api-key"]) safe["api-key"] = "<redacted len " + apiKey.length + ">";
  return safe;
}

async function probeChat(headers, withMachine) {
  const h = { ...headers };
  if (!withMachine) delete h["X-DeepAI-Code-Machine"];
  const payload = {
    model: PROBE_MODEL,
    messages: [{ role: "user", content: "ok" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8,
  };
  const chat = await fetch(MODEL_BASE + "/chat/completions", {
    method: "POST",
    headers: h,
    body: JSON.stringify(payload),
    redirect: "error",
  });
  const text = await chat.text().catch(() => "");
  return {
    ok: chat.ok && text.includes("chat.completion.chunk"),
    status: chat.status,
    detail: text.slice(0, 160).replace(/\s+/g, " "),
  };
}

/** Run every check for one account and return a report. Never throws. */
async function verifyAccount(acc) {
  // The lane is discovered, not hardcoded: make sure it is current before the
  // probe so the report reflects what the next real request would send.
  await refreshLane({ force: true });
  const headers = fingerprintHeaders(acc, {}, { machine: true });
  const report = {
    name: acc.name,
    lane: laneInfo(),
    username: acc.username,
    isPro: acc.isPro,
    headers: mask(headers, acc.apiKey),
    machineId: accountMachineId(acc, MACHINE_HEADER),
    machineSource: MACHINE_SOURCE,
    affinity: accountAffinity(acc),
    checks: {},
    ok: false,
    hint: "",
  };

  try {
    const theos = await fetch(MODEL_BASE + "/theos", {
      method: "GET",
      headers: { ...headers, "X-DeepAI-Code-Beacon": beaconHeader() },
      redirect: "error",
    });
    const body = await theos.text().catch(() => "");
    report.checks.theos = { ok: theos.ok, status: theos.status, detail: body.slice(0, 120).replace(/\s+/g, " ") };
  } catch (err) {
    report.checks.theos = { ok: false, status: 0, detail: String(err.message || err) };
  }

  try {
    report.checks.chatWithMachine = await probeChat(headers, true);
  } catch (err) {
    report.checks.chatWithMachine = { ok: false, status: 0, detail: String(err.message || err) };
  }

  try {
    report.checks.chatWithoutMachine = await probeChat(headers, false);
  } catch (err) {
    report.checks.chatWithoutMachine = { ok: false, status: 0, detail: String(err.message || err) };
  }

  const c = report.checks;
  const laneRefused = c.theos.status === 426 || c.chatWithMachine.status === 426 || c.chatWithoutMachine.status === 426;
  report.ok = c.theos.ok && c.chatWithMachine.ok && c.chatWithoutMachine.ok;
  if (!report.ok) {
    report.hint = laneRefused
      ? "the gateway refuses lane " + report.lane.version + " - run \"node deepai-proxy.mjs lane\" to re-discover it"
      : !c.chatWithMachine.ok && c.chatWithoutMachine.ok
        ? "the machine digest is rejected - run with DEEPAI_MACHINE_HEADER=0 or set a machineId on the account"
        : "the payload shape or the credential is rejected";
  }
  return report;
}

async function verify(name) {
  const accounts = listAccounts();
  const acc = findAccount(name || ACCOUNT_NAME || undefined);
  if (!acc) {
    console.error(
      accounts.length
        ? 'no account named "' + name + '" - known: ' + accounts.map((a) => a.name).join(", ")
        : 'no credential - run "login" or "import-app"',
    );
    process.exit(1);
  }

  const report = await verifyAccount(acc);
  console.log("account  : " + report.name + "  (" + (report.username || "?") + ", pro=" + report.isPro + ")");
  console.log(
    "lane     : " + report.lane.version + "  (source: " + report.lane.source +
      ", app " + report.lane.appVersion +
      (report.lane.autoDiscover ? ", auto-discovered" : ", pinned by env") + ")",
  );
  console.log("outgoing headers:");
  for (const [k, v] of Object.entries(report.headers)) console.log("  " + k + ": " + v);
  console.log("machine  : " + report.machineId.slice(0, 12) + "...  (local source: " + report.machineSource + ")");
  console.log("affinity : " + report.affinity);
  console.log();
  for (const [label, check] of Object.entries(report.checks)) {
    console.log(label.padEnd(20) + ": " + check.status + " " + check.detail);
  }
  console.log();
  if (!report.ok) {
    console.error("FAILED for " + report.name + " - " + report.hint);
    process.exit(1);
  }
  console.log("OK - the gateway accepts account " + report.name);
}

export { verify, verifyAccount };
