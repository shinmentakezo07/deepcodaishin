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

function recordRequest(kind) {
  state.requests += 1;
  state.lastRequestAt = new Date().toISOString();
  if (kind === "chat") state.chatRequests += 1;
  else if (kind === "messages") state.messageRequests += 1;
  else if (kind === "count_tokens") state.countTokenRequests += 1;
}

function recordUsage(usage, model) {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (Number.isFinite(prompt)) state.promptTokens += prompt;
  if (Number.isFinite(completion)) state.completionTokens += completion;
  if (model) state.lastModel = model;
}

function recordAccount(name) {
  if (name) state.lastAccount = name;
}

function recordError() {
  state.errors += 1;
}

function snapshot() {
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalTokens: state.promptTokens + state.completionTokens,
    ...state,
  };
}

export { recordRequest, recordUsage, recordAccount, recordError, snapshot };
