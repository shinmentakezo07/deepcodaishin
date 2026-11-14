import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.dirname(SRC_DIR);

export const ACC_PATH = process.env.ACC_PATH || path.join(ROOT_DIR, "acc.json");
// Optional second store in the named-account shape used by the src1 build.
export const ACCOUNTS_PATH = process.env.ACCOUNTS_PATH || path.join(ROOT_DIR, "accounts.json");
export const HOST = process.env.HOST || "127.0.0.1";
export const ACCOUNT_NAME = process.env.ACCOUNT || "";
export const PORT = Number(process.env.PORT || 8787);
export const PROXY_TOKEN = process.env.PROXY_TOKEN || "";
export const API_ORIGIN = (process.env.DEEPAI_API_ORIGIN || "https://api.deepai.org").replace(/\/+$/, "");
export const MODEL_BASE = API_ORIGIN + "/deepai_code";
// The lane the gateway is known to serve. This is only a *seed*: lane.mjs
// discovers the live value from the gateway (the app's X-DeepAI-Code-Theos
// header changes whenever DeepAI retires a release) and keeps it current in the
// running process, so a bump does not need a restart or an edit here.
export const LANE_VERSION = Number(process.env.DEEPAI_LANE_VERSION || 6);
// Set DEEPAI_LANE_AUTODISCOVER=0 to pin LANE_VERSION and never probe.
export const LANE_AUTODISCOVER = process.env.DEEPAI_LANE_AUTODISCOVER !== "0";
// How long a discovered lane is trusted before it is re-probed in the background.
export const LANE_REFRESH_MS = Number(process.env.DEEPAI_LANE_REFRESH_MS || 15 * 60 * 1000);
// Upper bound for the discovery walk; the gateway has never served anything near it.
export const LANE_MAX = 64;
// Fallback app version for the check-in beacon until the live one is fetched.
export const APP_VERSION = process.env.DEEPAI_APP_VERSION || "0.3.37";
export const APP_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
// Redirects to the current release file, e.g. DeepAI-Code-0.3.37-x86_64.AppImage.
export const DOWNLOAD_PROBE_URL = "https://deepai.org/download/deepai-code/linux-x64";
// Off by default: the local digest is the value the gateway rejected on this
// machine. Each account still carries its own digest (see account.mjs), so
// DEEPAI_MACHINE_HEADER=1 sends the account digest instead of the local one.
export const SEND_MACHINE_HEADER = process.env.DEEPAI_MACHINE_HEADER === "1";
export const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";
// Extra browser origins allowed to call the panel API, comma separated
// (e.g. a custom domain in front of a platform hostname). Same-origin is always
// allowed, so this is only needed for a second hostname.
export const EXTRA_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean),
);
export const DEBUG_HEADERS = process.env.DEBUG_HEADERS === "1";

// The desktop app's own data folder, used by import-app and as a model catalog.
export const APP_USERDATA =
  process.env.DEEPAI_USERDATA ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".deepai-code", "userdata");
export const APP_ACCOUNT_BIN = path.join(APP_USERDATA, "secrets", "deepai-account.bin");
export const APP_MODELS_JSON = path.join(APP_USERDATA, "deepai", "pi", "deepai", "models.json");
