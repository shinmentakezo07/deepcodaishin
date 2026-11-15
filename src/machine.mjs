import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------- machine id
//
// The digest the app sends in X-DeepAI-Code-Machine. Kept apart from
// fingerprint.mjs so lane discovery can present the same digest on its /theos
// check-in without importing the header builder (which reads the live lane).

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

function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * Which raw id the digest is built from.
 *
 * The app tries SMBIOS first and falls back to MachineGuid, but in the packaged
 * build the SMBIOS probe usually does not answer in time, so what the gateway has
 * registered is sha256(MachineGuid). Sending the SMBIOS digest is rejected with
 * 400 "This request is not one DeepAI Code sends.", so win32 reads MachineGuid
 * first. Override with DEEPAI_MACHINE_ID when a machine differs.
 */
function rawMachineUuid() {
  if (process.platform === "win32") {
    const reg = run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const g = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(reg || "");
    if (g && UUID_RE.test(g[1])) return { raw: g[1].toLowerCase(), source: "machine-guid" };

    const smbios = run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
    ]);
    const m = UUID_RE.exec(smbios || "");
    if (m && !PLACEHOLDERS.has(m[0].toLowerCase())) return { raw: m[0].toLowerCase(), source: "smbios" };
    return null;
  }
  if (process.platform === "darwin") {
    const out = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out || "");
    return m && UUID_RE.test(m[1]) ? { raw: m[1].toLowerCase(), source: "ioplatformuuid" } : null;
  }
  for (const p of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim().toLowerCase();
      if (UUID_RE.test(v) && !PLACEHOLDERS.has(v)) return { raw: v, source: basename(p) };
      if (p.endsWith("machine-id") && v.length >= 32) return { raw: v, source: "machine-id" };
    } catch {}
  }
  return null;
}

const MACHINE = (() => {
  const override = process.env.DEEPAI_MACHINE_ID;
  if (override) {
    return { digest: crypto.createHash("sha256").update(override).digest("hex"), source: "env" };
  }
  const found = rawMachineUuid();
  if (!found) return null;
  return { digest: crypto.createHash("sha256").update(found.raw).digest("hex"), source: found.source };
})();

/** Digest of this computer, used when an account asks for machineId:"local". */
const MACHINE_HEADER = MACHINE ? MACHINE.digest : null;
const MACHINE_SOURCE = MACHINE ? MACHINE.source : "unavailable";

export { MACHINE_HEADER, MACHINE_SOURCE, rawMachineUuid };
