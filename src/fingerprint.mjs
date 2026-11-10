import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { LANE_VERSION, SEND_MACHINE_HEADER } from "./config.mjs";

// ---------------------------------------------------------------- fingerprint

const INSTANCE_ID = crypto.randomBytes(16).toString("hex"); // per process, like the app
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

function run(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout || "" : "";
}

function rawMachineUuid() {
  if (process.platform === "win32") {
    const smbios = run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
    ]);
    const m = UUID_RE.exec(smbios || "");
    if (m && !PLACEHOLDERS.has(m[0].toLowerCase())) return m[0].toLowerCase();

    const reg = run("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    const g = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(reg || "");
    if (g && UUID_RE.test(g[1])) return g[1].toLowerCase();
    return null;
  }
  if (process.platform === "darwin") {
    const out = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out || "");
    return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
  }
  for (const p of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim().toLowerCase();
      if (UUID_RE.test(v) && !PLACEHOLDERS.has(v)) return v;
      if (p.endsWith("machine-id") && v.length >= 32) return v;
    } catch {}
  }
  return null;
}

const MACHINE_HEADER = (() => {
  const raw = rawMachineUuid();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
})();

function fingerprintHeaders(apiKey, extra = {}) {
  const h = {
    "Content-Type": "application/json",
    "X-DeepAI-Code-Theos": String(LANE_VERSION),
    "X-DeepAI-Code-Instance": INSTANCE_ID,
    "api-key": apiKey,
  };
  if (MACHINE_HEADER && SEND_MACHINE_HEADER) h["X-DeepAI-Code-Machine"] = MACHINE_HEADER;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") continue;
    h[k] = v;
  }
  return h;
}

export { MACHINE_HEADER, fingerprintHeaders };
