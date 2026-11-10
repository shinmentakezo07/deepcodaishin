import fs from "node:fs";
import { ACC_PATH, APP_ACCOUNT_BIN } from "./config.mjs";
import {
  loadAccounts,
  loadSettings,
  saveSettings,
  listAccountSummaries,
  addAccount,
  updateAccount,
  removeAccountAt,
  clearAccounts,
  loadAccount,
  maskKey,
  accountCount,
  accountsRevision,
  rotationState,
  findAppAccounts,
  captureAppAccounts,
  findAccount,
  coolingAccounts,
} from "./account.mjs";
import { startLoginFlow, completeLoginFromText, pendingStates } from "./login.mjs";
import { verifyAccount } from "./verify.mjs";
import { snapshot } from "./metrics.mjs";

// ---------------------------------------------------------------- api routes

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errBody(message, type = "api_error") {
  return { type: "error", error: { type, message } };
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function accountsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.accounts)) return input.accounts;
  if (input && typeof input.apiKey === "string") return [input];
  return [];
}

function addMany(accounts) {
  let added = 0;
  let updated = 0;
  const errors = [];
  for (const acc of accounts) {
    try {
      const result = addAccount(acc);
      if (result.added) added += 1;
      else updated += 1;
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  return { added, updated, errors };
}

function accountsPayload() {
  return {
    count: accountCount(),
    accounts: listAccountSummaries(),
    settings: loadSettings(),
    accountsRevision: accountsRevision(),
    rotation: rotationState(),
    pendingLogins: pendingStates().length,
  };
}

async function handleApi(req, res, url, healthPayload) {
  const p = url.pathname;

  if (p === "/api/accounts/export" && req.method === "GET") {
    return json(res, 200, { accounts: loadAccounts() });
  }

  if (p === "/api/accounts") {
    if (req.method === "GET") {
      return json(res, 200, accountsPayload());
    }
    if (req.method === "POST") {
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
      }
      const list = accountsFrom(input);
      if (list.length === 0) {
        return json(res, 400, errBody("provide an account object or an accounts array", "invalid_request_error"));
      }
      const result = addMany(list);
      if (result.added + result.updated === 0) {
        return json(res, 400, errBody("no valid accounts: " + result.errors.join("; "), "invalid_request_error"));
      }
      return json(res, 200, {
        saved: true,
        added: result.added,
        updated: result.updated,
        errors: result.errors,
        ...accountsPayload(),
      });
    }
    if (req.method === "DELETE") {
      clearAccounts();
      return json(res, 200, { deleted: true, ...accountsPayload() });
    }
    return json(res, 405, errBody("method not allowed", "invalid_request_error"));
  }

  if (p.startsWith("/api/accounts/")) {
    const id = p.slice("/api/accounts/".length);
    if (/^[0-9]+$/.test(id)) {
      const index = Number(id);
      if (req.method === "DELETE") {
        const removed = removeAccountAt(index);
        if (!removed) return json(res, 404, errBody("account not found", "not_found_error"));
        return json(res, 200, {
          removed: { username: removed.username, maskedKey: maskKey(removed.apiKey) },
          ...accountsPayload(),
        });
      }
      if (req.method === "PATCH" || req.method === "POST") {
        let patch;
        try {
          patch = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
        }
        const updated = updateAccount(index, patch || {});
        if (!updated) return json(res, 404, errBody("account not found", "not_found_error"));
        return json(res, 200, {
          updated: { index, username: updated.username, weight: updated.weight },
          ...accountsPayload(),
        });
      }
      return json(res, 405, errBody("method not allowed", "invalid_request_error"));
    }
    return json(res, 404, errBody("unsupported endpoint", "not_found_error"));
  }

  if (p === "/api/settings") {
    if (req.method === "GET") {
      return json(res, 200, { settings: loadSettings(), rotation: rotationState() });
    }
    if (req.method === "POST") {
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
      }
      const settings = saveSettings(input || {});
      return json(res, 200, { saved: true, settings, ...accountsPayload() });
    }
    return json(res, 405, errBody("method not allowed", "invalid_request_error"));
  }

  if (p === "/api/verify" && req.method === "POST") {
    let input = {};
    try {
      const raw = await readBody(req);
      if (raw) input = JSON.parse(raw);
    } catch {
      return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
    }
    const acc = findAccount(input.name || undefined);
    if (!acc) return json(res, 404, errBody("account not found", "not_found_error"));
    const report = await verifyAccount(acc);
    return json(res, report.ok ? 200 : 502, report);
  }

  if (p === "/api/login/callback" && req.method === "POST") {
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
    }
    const raw = (input && (input.url || input.text || input.code)) || "";
    const result = await completeLoginFromText(raw);
    if (!result.ok) return json(res, result.status || 400, errBody(result.message, "invalid_request_error"));
    return json(res, 200, {
      signedIn: true,
      username: result.username,
      capture: result.capture,
      ...accountsPayload(),
    });
  }

  if (p === "/api/capture") {
    if (req.method === "GET") {
      const found = findAppAccounts();
      return json(res, 200, {
        found: found.length,
        sources: found.map((f) => f.source),
        accounts: found.map((f) => ({ username: f.username, isPro: f.isPro, source: f.source })),
      });
    }
    if (req.method === "POST") {
      const result = captureAppAccounts();
      return json(res, 200, { ...result, ...accountsPayload() });
    }
    return json(res, 405, errBody("method not allowed", "invalid_request_error"));
  }

  // Legacy single-account endpoints, kept for older clients.
  if (p === "/api/account") {
    if (req.method === "GET") {
      const a = loadAccount();
      if (!a) return json(res, 404, errBody("no credential stored", "not_found_error"));
      return json(res, 200, { apiKey: a.apiKey, username: a.username || "", isPro: a.isPro === true });
    }
    if (req.method === "POST") {
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, errBody("invalid JSON body", "invalid_request_error"));
      }
      const list = accountsFrom(input);
      if (list.length === 0) {
        return json(res, 400, errBody("apiKey is required", "invalid_request_error"));
      }
      const result = addMany(list);
      if (result.added + result.updated === 0) {
        return json(res, 400, errBody("no valid accounts: " + result.errors.join("; "), "invalid_request_error"));
      }
      return json(res, 200, { saved: true, ...accountsPayload() });
    }
    if (req.method === "DELETE") {
      clearAccounts();
      return json(res, 200, { deleted: true, ...accountsPayload() });
    }
    return json(res, 405, errBody("method not allowed", "invalid_request_error"));
  }

  if (p === "/api/import-app" && req.method === "POST") {
    const result = captureAppAccounts();
    if (result.found === 0) {
      return json(res, 404, errBody("no desktop app credential found at " + APP_ACCOUNT_BIN, "not_found_error"));
    }
    return json(res, 200, { imported: true, ...result, ...accountsPayload() });
  }

  if (p === "/api/login" && req.method === "POST") {
    try {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch {}
      const flow = await startLoginFlow(body.name);
      return json(res, 200, { started: true, authUrl: flow.authUrl, port: flow.port });
    } catch (err) {
      return json(res, 500, errBody("could not start login: " + err.message));
    }
  }

  if (p === "/api/usage" && req.method === "GET") {
    const accounts = listAccountSummaries();
    const first = accounts[0];
    return json(res, 200, {
      ...snapshot(),
      signedIn: accounts.length > 0,
      username: first ? first.username : null,
      isPro: first ? first.isPro : null,
      accountCount: accounts.length,
      settings: loadSettings(),
      rotation: rotationState(),
      cooling: coolingAccounts(),
    });
  }

  if (p === "/api/health" && req.method === "GET") {
    return json(res, 200, healthPayload());
  }

  return json(res, 404, errBody("unsupported endpoint", "not_found_error"));
}

export { handleApi };
