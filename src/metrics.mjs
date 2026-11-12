const startedAt = Date.now();

const state = {
  requests: 0,
  chatRequests: 0,
  messageRequests: 0,
  countTokenRequests: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  lastRequestAt: null,
  lastModel: null,
  lastAccount: null,
};

/**
 * Per-account counters, keyed by a stable id (the tail of the api key) so a
 * rename does not orphan the numbers. One entry per account that was actually
 * used, with the display name refreshed on every call.
 */
const perAccount = new Map();
let lastAccountId = null;

function accountId(acc) {
  const key = acc && acc.apiKey ? String(acc.apiKey) : "";
  return key ? key.slice(-8) : String((acc && acc.name) || "");
}

function bucket(id, name) {
  let entry = perAccount.get(id);
  if (!entry) {
    entry = { id, name: name || "", requests: 0, errors: 0, rejected: 0, promptTokens: 0, completionTokens: 0, lastAt: null };
    perAccount.set(id, entry);
  }
  if (name) entry.name = name;
  return entry;
}

function recordRequest(kind) {
  state.requests += 1;
  state.lastRequestAt = new Date().toISOString();
  if (kind === "chat") state.chatRequests += 1;
  else if (kind === "messages") state.messageRequests += 1;
  else if (kind === "count_tokens") state.countTokenRequests += 1;
}

/** Called once per upstream attempt, so failover shows up per account. */
function recordAccount(acc) {
  if (!acc) return;
  const id = accountId(acc);
  if (!id) return;
  lastAccountId = id;
  state.lastAccount = acc.name || id;
  const entry = bucket(id, acc.name);
  entry.requests += 1;
  entry.lastAt = new Date().toISOString();
}

/**
 * Usage and errors are attributed to the account of *this* request, which the
 * caller passes explicitly. A module-global "last account used" is wrong as
 * soon as two requests overlap: the loser's tokens land on the winner.
 */
function recordUsage(usage, model, acc) {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (Number.isFinite(prompt)) state.promptTokens += prompt;
  if (Number.isFinite(completion)) state.completionTokens += completion;
  if (model) state.lastModel = model;

  const id = acc ? accountId(acc) : lastAccountId;
  if (id) {
    const entry = perAccount.get(id);
    if (entry) {
      if (Number.isFinite(prompt)) entry.promptTokens += prompt;
      if (Number.isFinite(completion)) entry.completionTokens += completion;
    }
  }
}

function recordError(acc) {
  state.errors += 1;
  const id = acc ? accountId(acc) : lastAccountId;
  if (id) {
    const entry = perAccount.get(id);
    if (entry) entry.errors += 1;
  }
}

/**
 * An attempt this account refused (401/403/429) while the request moved on to
 * another one. Counted per account, never as a failed request.
 */
function recordRejection(acc) {
  if (!acc) return;
  const id = accountId(acc);
  if (!id) return;
  bucket(id, acc.name).rejected = (bucket(id, acc.name).rejected || 0) + 1;
}

function perAccountList() {
  return [...perAccount.values()]
    .map((e) => ({
      id: e.id,
      name: e.name,
      requests: e.requests,
      errors: e.errors,
      rejected: e.rejected || 0,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      totalTokens: e.promptTokens + e.completionTokens,
      lastAt: e.lastAt,
    }))
    .sort((a, b) => b.requests - a.requests);
}

function snapshot() {
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalTokens: state.promptTokens + state.completionTokens,
    ...state,
    perAccount: perAccountList(),
  };
}

function resetMetrics() {
  perAccount.clear();
  lastAccountId = null;
  Object.assign(state, {
    requests: 0,
    chatRequests: 0,
    messageRequests: 0,
    countTokenRequests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastRequestAt: null,
    lastModel: null,
    lastAccount: null,
  });
}

export { recordRequest, recordUsage, recordAccount, recordRejection, recordError, snapshot, resetMetrics };
