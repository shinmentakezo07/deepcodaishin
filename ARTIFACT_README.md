# deepai-proxy Quick Reference

## Commands
```
node deepai-proxy.mjs login [name]          # Browser sign-in
node deepai-proxy.mjs import-app [name]     # Copy desktop credential
node deepai-proxy.mjs accounts              # List accounts + machine digests
node deepai-proxy.mjs use <name>            # Switch active account
node deepai-proxy.mjs verify [name]         # Live fingerprint check
node deepai-proxy.mjs whoami [name]         # Show account info
node deepai-proxy.mjs serve                 # Start proxy on 127.0.0.1:8787
```

## Endpoints (via proxy at http://127.0.0.1:8787/)
- `POST /v1/chat/completions` - OpenAI-style chat
- `POST /v1/messages` - Anthropic-style messages
- `POST /v1/messages/count_tokens` - Token counting
- `GET /v1/models` - Model catalog
- `GET /health` - Health check
- `GET /` - Control panel UI

## Fingerprint Headers Sent
```
Content-Type: application/json
X-DeepAI-Code-Theos: 4
X-DeepAI-Code-Instance: <32 hex per process>
X-DeepAI-Code-Machine: <per-account digest or local>
api-key: <account key>
X-Session-Affinity: <8-char UUID per account>
```

## Account Store
- `accounts.json` - Full multi-account store (weights, machineId, affinity per account)
- `acc.json` - Legacy single-account mirror (apiKey, username, isPro)
- Both written by `saveStore()` when paths differ

## Multiple Accounts
- Set active: `node deepai-proxy.mjs use <name>`
- Per-request selection: `?account=<name>`, `x-proxy-account: <name>`, or `ACCOUNT=<name>` env
- Weights control round-robin frequency
- Cooldowns park refused accounts for 60s default