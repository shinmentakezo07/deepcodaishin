const JSON_HEADERS = { "Content-Type": "application/json" };

async function request(path, options) {
  const init = Object.assign({ headers: JSON_HEADERS }, options || {});
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message =
      (data && data.error && data.error.message) ||
      (data && data.message) ||
      "HTTP " + res.status;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request("/health"),
  models: () => request("/v1/models"),
  accounts: () => request("/api/accounts"),
  usage: () => request("/api/usage"),
  settings: (patch) => request("/api/settings", { method: "POST", body: JSON.stringify(patch) }),
  patchAccount: (index, patch) =>
    request("/api/accounts/" + index, { method: "PATCH", body: JSON.stringify(patch) }),
  removeAccount: (index) => request("/api/accounts/" + index, { method: "DELETE" }),
  removeAll: () => request("/api/accounts", { method: "DELETE" }),
  addAccounts: (payload) =>
    request("/api/accounts", { method: "POST", body: JSON.stringify(payload) }),
  exportAccounts: () => request("/api/accounts/export"),
  captureScan: () => request("/api/capture"),
  captureImport: () => request("/api/capture", { method: "POST", body: "{}" }),
  startLogin: (name) => request("/api/login", { method: "POST", body: JSON.stringify({ name: name || "" }) }),
  completeLogin: (text) =>
    request("/api/login/callback", { method: "POST", body: JSON.stringify({ url: text }) }),
  verify: (name) => request("/api/verify", { method: "POST", body: JSON.stringify({ name }) }),
  chat: (payload) =>
    request("/v1/chat/completions", { method: "POST", body: JSON.stringify(payload) }),
  countTokens: (payload) =>
    request("/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(payload) }),
};

export function cx() {
  const out = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (v) out.push(v);
  }
  return out.join(" ");
}

export function fmtNum(n) {
  if (typeof n !== "number" || !isFinite(n)) return "-";
  return n.toLocaleString();
}

export function fmtUptime(seconds) {
  if (typeof seconds !== "number") return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + "h " + m + "m " + (seconds % 60) + "s";
}

export function fmtTime(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return String(iso);
  }
}
