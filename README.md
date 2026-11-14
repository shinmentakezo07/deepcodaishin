# deepai-proxy
q
A local HTTP proxy that exposes a **DeepAI Code desktop account** as an OpenAI-compatible and
Anthropic-compatible endpoint, using the same sign-in flow and the same wire fingerprint as the app.

- OpenAI: `POST /v1/chat/completions`
- Anthropic: `POST /v1/messages` (streaming and non-streaming), `POST /v1/messages/count_tokens`
- Discovery: `GET /v1/models`, `GET /health`

No dependencies. Node 18+ (tested on Node 24). Binds `127.0.0.1` only.

Docs:

| file | content |
|---|---|
| `HOWIBUILD.md` | how it was reverse-engineered, the real protocol, every design decision, pitfalls, troubleshooting |
| `DOCKER.md` | running it in a container |
| `README.md` | this file — usage |

---

## Quick start

```bash
node deepai-proxy.mjs import-app    # or: node deepai-proxy.mjs login
node deepai-proxy.mjs verify        # proves the gateway accepts the fingerprint
node deepai-proxy.mjs serve         # http://127.0.0.1:8787  (+ the control panel)
```

## Control panel

`serve` also hosts a panel at <http://127.0.0.1:8787/>. It manages accounts, weights, the
round-robin toggle, the machine header, sign-in (including pasting a callback URL), import/export,
usage counters, and a test request.

The panel is a Vite + React + Tailwind app in `ui/`. The build output (`ui/dist`) is committed, so
the proxy serves it with no build step and no runtime dependencies. Without it the proxy falls back
to the single-file panel in `src/ui.html`.

```bash
cd ui && npm install && npm run build   # rebuild ui/dist after editing ui/src
cd ui && npm run dev                    # hot reload on :5173, proxying /api and /v1 to :8787
```

Then:

```bash
# OpenAI-style
curl http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-style
curl http://127.0.0.1:8787/v1/messages -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Point a client at it with `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` or
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and any placeholder API key.

Stop it with `taskkill //F //PID <pid>` (the pid is printed at startup; find it with
`netstat -ano | grep :8787`).

---

## Commands

| command | what it does |
|---|---|
| `serve` *(default)* | start the proxy |
| `login [name]` | browser sign-in against `api.deepai.org`, saved as account `name` (default `default`) |
| `import-app [name]` | copy the credential the desktop app already has in `~/.deepai-code/userdata/secrets/deepai-account.bin` |
| `accounts` | list accounts, active flag, per-account machine digest |
| `use <name>` | switch the active account |
| `verify [name]` | print the outgoing headers + the discovered lane, call `/theos` + one 8-token streamed chat; exits non-zero on rejection |
| `lane` | re-discover the lane version the gateway currently serves (and the current app version) and print it |
| `whoami [name]` | masked key, machine digest, store path |

---

## Multiple accounts

`accounts.json` (mode 0600) holds all of them; each gets its own machine digest and affinity, so no
two accounts look like the same machine.

```jsonc
{
  "active": "main",
  "accounts": [
    { "name": "main",   "apiKey": "…", "username": "…", "isPro": false },
    { "name": "second", "apiKey": "…", "username": "…", "machineId": "laptop-b" }
  ]
}
```

`machineId` is optional:

| value | digest sent |
|---|---|
| *(omitted)* | `sha256("deepai-proxy:" + name)` — stable, distinct per account |
| `"local"` | the real digest of this computer |
| 64 hex chars | used verbatim |
| any other string | `sha256(string)` — seed a machine from a label |

Per-request selection: `?account=<name>` → `x-proxy-account: <name>` → `ACCOUNT=<name>` → `active`.

`acc.json` is kept as a mirror of the active account for anything that reads the old single-account
path.

> Daily Theos is granted **per machine digest**. Two accounts sharing one digest share one grant pool
> and look like multi-accounting on one machine — the per-account default exists to keep them separate.

---

## Configuration

| env | default | purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `ACCOUNTS_PATH` | `./accounts.json` | multi-account store |
| `ACC_PATH` | `./acc.json` | mirror of the active account |
| `ACCOUNT` | `active` from the store | default account |
| `PROXY_TOKEN` | *(empty)* | require `Authorization: Bearer <token>` on `/api/*` and `/v1/*` (`/health`, `/v1/models`, the panel itself stay public; the panel asks for the token once and keeps it in `localStorage`) |
| `DEEPAI_API_ORIGIN` | `https://api.deepai.org` | origin override |
| `DEEPAI_USERDATA` | `~/.deepai-code/userdata` | source for `import-app` and the model catalog |
| `DEEPAI_MACHINE_HEADER` | off (`1` enables) | send `X-DeepAI-Code-Machine` (per-account digest) |
| `DEEPAI_MACHINE_ID` | auto | raw id to hash into the machine header |
| `DEEPAI_SESSION_AFFINITY` | per account | force one affinity value |
| `DEEPAI_LANE_VERSION` | `6` | seed for lane discovery — the lane is discovered from the gateway, not assumed |
| `DEEPAI_LANE_AUTODISCOVER` | on (`0` pins the seed) | stop probing the gateway; `426 lane_version_unsupported` is then surfaced as-is |
| `DEEPAI_LANE_REFRESH_MS` | `900000` | how long a discovered lane is trusted before a background re-probe (a `426` always forces one) |
| `DEEPAI_APP_VERSION` | `0.3.37` | fallback `v=` for the check-in beacon; the live release is read from the download redirect |
| `STORE_CACHE_TTL_MS` | `250` | how long the parsed account store is reused before the files are re-stat'ed; `0` re-reads on every call |
| `KEEPALIVE_TIMEOUT_MS` | `65000` | how long an idle client connection is kept open for reuse (Node's default of 5s is shorter than the pause between chat turns) |
| `LOG_REQUESTS` | off | log inbound requests, credentials redacted |
| `DEBUG` | off | log the exact upstream JSON body |
| `DEBUG_HEADERS` | off | log the exact outgoing header set, key masked |
| `ALLOWED_ORIGINS` | *(empty)* | extra browser origins allowed to call the panel API (comma separated) |

---

## Files

```
deepai-proxy.mjs            CLI entry point: command dispatch (login, import-app, accounts, use, verify, whoami, serve)
src/
├── config.mjs              env + paths
├── account.mjs             accounts.json store, per-account machine id + affinity, rotation
├── login.mjs               desktop auth flow, exchange, import-app
├── fingerprint.mjs         instance / machine / affinity headers, header set
├── lane.mjs                lane discovery, background refresh, check-in beacon
├── models.mjs              catalog ids
├── upstream.mjs            payload normalisation + upstream fetch
├── anthropic-to-openai.mjs request translation
├── openai-to-anthropic.mjs response translation
├── stream-aggregate.mjs    SSE -> single chat.completion
├── anthropic-stream.mjs    OpenAI SSE -> Anthropic SSE
├── stream-guard.mjs        relay upstream SSE, rewrite early termination as retryable 502
├── http-server.mjs         HTTP router + handlers + keep-alive
├── api.mjs                 /api/* control-panel endpoints
├── metrics.mjs             request/usage counters (per account)
├── verify.mjs              live fingerprint check
└── ui.html                 single-file panel fallback
accounts.json               credential store (0600)
acc.json                    mirror of the active account
```

---

## Security

- `accounts.json` / `acc.json` contain the account key **in plaintext** (the app stores the same key
  the same way in `~/.deepai-code/userdata/secrets/deepai-account.bin`). Treat them as passwords;
  delete them when finished.
- Loopback bind only. Requests carrying an `Origin` header are refused, exactly like the app, which
  blocks drive-by browser calls.
- Add `PROXY_TOKEN` if other local processes should not be able to spend your Theos.
- Every call is billed to the account. Models with `theosPerRequest: "0"` in the app's catalog are free.
- Driving a desktop client's private endpoint from other tools may be outside DeepAI's terms of
  service. That call is yours to make.
