import fs from "node:fs";
import { APP_MODELS_JSON } from "./config.mjs";

// ---------------------------------------------------------------- catalog

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

/** Model ids from the app's generated catalog, if present. */
function catalogIds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(APP_MODELS_JSON, "utf8"));
    const list = cfg?.providers?.deepai?.models;
    if (Array.isArray(list) && list.length) return list.map((m) => m.id);
  } catch {}
  return FALLBACK_MODELS;
}

export { FALLBACK_MODELS, catalogIds };
