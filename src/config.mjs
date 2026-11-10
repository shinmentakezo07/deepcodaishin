import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.dirname(SRC_DIR);

export const ACC_PATH = process.env.ACC_PATH || path.join(ROOT_DIR, "acc.json");
export const PORT = Number(process.env.PORT || 8787);
export const PROXY_TOKEN = process.env.PROXY_TOKEN || "";
export const API_ORIGIN = (process.env.DEEPAI_API_ORIGIN || "https://api.deepai.org").replace(/\/+$/, "");
export const MODEL_BASE = `${API_ORIGIN}/deepai_code`;
export const LANE_VERSION = 4;
// The gateway rejects an unregistered digest, so this stays opt-in.
export const SEND_MACHINE_HEADER = process.env.DEEPAI_MACHINE_HEADER === "1";

// The desktop app's own data folder, used by `import-app` and as a model catalog.
export const APP_USERDATA =
  process.env.DEEPAI_USERDATA ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".deepai-code", "userdata");
export const APP_ACCOUNT_BIN = path.join(APP_USERDATA, "secrets", "deepai-account.bin");
export const APP_MODELS_JSON = path.join(APP_USERDATA, "deepai", "pi", "deepai", "models.json");
