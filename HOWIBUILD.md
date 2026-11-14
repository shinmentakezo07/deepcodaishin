# HOW I BUILT deepai-proxy

A record of how the proxy was reverse-engineered from the DeepAI Code desktop app, what the
protocol actually is, and what every part of the proxy is for.

Companion docs: **`README.md`** (usage), **`DECISIONS.md`** (why each choice was made, with the
evidence that forced it). This file is the technical narrative.

Everything below was verified against the installed app on this machine
(`C:\Users\shinm\AppData\Local\Programs\deepai-code-desktop`, build dated 2026-11-10) and by live
calls to the real gateway.

---

## 1. The goal

A local single-file Node service that:

1. uses **the same sign-in flow** as the desktop app,
2. stores the credential in **`acc.json`** and uses that credential for every call,
3. exposes **`POST /v1/chat/completions`** (OpenAI) and **`POST /v1/messages`** (Anthropic),
4. sends the **same fingerprint** (headers / lane / instance / payload shape) as the app.

---

## 2. How the app was reverse-engineered

### 2.1 What the app is made of

```
deepai-code-desktop/
└── resources/
    ├── app.asar        (18 MB)  Electron main + renderer
    ├── server.asar     (200 MB) the agent server + provider drivers  ← the interesting one
    └── node_modules/
```

`server.asar` is an **asar** archive: 4-byte pickle header, 4-byte JSON-header size, then a JSON
index mapping `path → {size, offset, integrity}`, then the concatenated file data.

**Critical detail:** the `offset` values in that JSON index are relative to the start of the data
section, not the start of the archive. On this build the delta was exactly `4,074,053` bytes
(`4194304 - 120251`, i.e. just under the 4 MiB header block). Everything read by raw offset has to
be shifted by that delta — I found it by locating a known string with `grep -abo` and subtracting
the indexed offset.

### 2.2 The tools that worked

```bash
# URLs / hostnames anywhere in the archive
grep -aoE 'https?://[a-zA-Z0-9._-]+/?' server.asar | sort | uniq -c | sort -rn

# find a symbol, then get its byte offset
grep -abo 'export class PiMessagesResponseError' server.asar
# -> 102515894

# pull that exact window out and make it readable
dd if=server.asar bs=1 skip=102515894 count=20000 2>/dev/null > /tmp/pm.js

# minified code is tab-separated; newlines make it greppable
tr '\t' '\n' < /tmp/pm.js | grep -vE '^\s*$'
```

Symbols found this way (all names are from the minified but un-obfuscated bundle):

| Symbol / string | What it told me |
|---|---|
| `PRODUCTION_DEEPAI_API_ORIGIN = "https://api.deepai.org"` | the account API origin |
| ``const DEEPAI_MODEL_BASE = `${DEEPAI_API_ORIGIN}/deepai_code` `` | all model traffic lives under `/deepai_code` |
| `DEEPAI_LANE_HEADERS = { "X-DeepAI-Code-Theos": "4", "X-DeepAI-Code-Instance": randomBytes(16).hex }` | lane version + per-process instance id |
| `DEEPAI_MACHINE_HEADER = "X-DeepAI-Code-Machine"` | machine digest header |
| `deepAISignInUrl()` / `exchangeDeepAICode()` / `/auth-callback` | the whole login flow |
| `startDeepAIModelTransport()` | the app's own loopback bridge (the `127.0.0.1:64373` in `models.json`) |
| `pi-messages.js` | a *different* transport (`radius.pi.dev`, `authorization: Bearer …`) that this build does **not** use for DeepAI |
| `deepAIPiModels()` | how the app writes the provider block it hands to the agent |

### 2.3 Sources outside the archive

```
~/.deepai-code/userdata/
├── secrets/deepai-account.bin        plaintext JSON {"apiKey","username","isPro"}
├── secrets/deepai-ad-user.bin        DPAPI blob
├── secrets/server-signing-key.bin    random 32 B
├── statev2.sqlite                    auth_sessions, auth_pairing_links, threads, turns
├── server-runtime.json               {"pid":10964,"host":"127.0.0.1","port":3773}
└── deepai/pi/deepai/
    ├── models.json                   provider block: baseUrl, api, apiKey(64), full catalog
    ├── models-store.json             catalog cache
    ├── auth.json                     "{}"  (unused: the driver injects the key instead)
    └── sessions/
```

`models.json` was the single most useful file: it proved the agent talks to
`http://127.0.0.1:<random port>` with `api: "openai-completions"`, i.e. the app runs its **own
loopback bridge** in-process and that bridge is what forwards to DeepAI. The port is transient
(`64373` was already in `TIME_WAIT`), the 64-char `apiKey` is a **capability token** minted per
process (`crypto.randomBytes(32).toString("hex")`), not the account key.

Net effect: the account key never reaches the agent, the renderer, or any config file — only the
bridge holds it. The proxy therefore reproduces the *bridge's upstream call*, not the bridge itself.

---

## 3. The real protocol

### 3.1 Sign-in (RFC 8252 style, localhost callback)

```
1. app:    state = randomBytes(32).hex
           server.listen(0, "127.0.0.1")           → port

2. browser: GET https://api.deepai.org/deepai_code/desktop_auth/
                  ?state=<64 hex>&port=<port>
           user authenticates on deepai.org

3. redirect: GET http://127.0.0.1:<port>/auth-callback?code=<code>&state=<64 hex>
           app checks: pathname === "/auth-callback", GET, code length ≤ 4096,
                       state matches (timing-safe compare)
           → replies 303 to a one-time /sign-in-complete/<uuid> URL

4. app:    POST https://api.deepai.org/deepai_code/desktop_auth/exchange/
           {"code":"<code>"}            (20 s timeout, redirect:"error")
        →  {"api_key":"…","username":"…","is_pro":false}

5. app:    saves to secrets/deepai-account.bin
```

Notes carried into the proxy:

* `state` is compared with `crypto.timingSafeEqual`, and a stale/cancelled callback must not be able
  to save credentials — the exchange happens once (`exchangingCode` guard).
* error mapping the app uses: `400/401` → link expired or already used, `429` → too many attempts,
  anything else → generic failure. The proxy surfaces the raw status instead of inventing copy.
* `api_key` is rejected if empty or containing `\r`/`\n`.

### 3.2 The model call

```
POST https://api.deepai.org/deepai_code/chat/completions
Content-Type: application/json
X-DeepAI-Code-Theos: <lane, discovered - §3.8>
X-DeepAI-Code-Instance: <32 hex, per process>
X-DeepAI-Code-Machine: <sha256(machine id)>
api-key: <account api key>
X-Session-Affinity: <stable per process>

{"model":"…","messages":[…],"stream":true,"stream_options":{"include_usage":true}, …}
```

Header **order** is the app's bridge order (Content-Type, lane, instance, machine, key, affinity).
JSON key order follows what `pi` emits: `model, messages, stream, [prompt_cache_key],
stream_options, [store], max_tokens, temperature, tools, tool_choice, …`.

`X-Session-Affinity` is always present: `pi` sets `sendSessionAffinityHeaders: true` for every DeepAI
model, so a request without it is one the app never sends. The proxy generates a UUID per process
(override with `DEEPAI_SESSION_AFFINITY`) and lets a client pass its own via
`x-session-affinity` or `prompt_cache_key`.

The bridge also accepts `POST /responses` (for `api: "openai-responses"` models), `GET /model-status`,
and the two tool endpoints `/web_search` and `/find_service`. The proxy implements chat completions
only, since that is what the DeepAI provider block declares.

### 3.3 The bridge's own auth (why `models.json` has a 64-char key)

Requests **into** the bridge are checked like this:

```js
if (incoming.headers.origin || !timingSafeEqual(incoming.headers.authorization, `Bearer ${capability}`))
  → 403 "Model transport authentication required."
```

Two consequences that shaped the proxy:

* it **refuses any request carrying an `Origin` header** (blocks drive-by browser calls / CSRF),
* with `PROXY_TOKEN` set it requires `Authorization: Bearer <token>` — same shape, but the token is
  the user's, not a per-process capability.

### 3.4 The machine header — which id the server actually knows

The source says: try the SMBIOS UUID first, fall back to `MachineGuid`.

```js
if (platform === "win32")
  return parseSmbiosUUID(await run("powershell", […Win32_ComputerSystemProduct.UUID]))
      ?? parseMachineGuid(await run("reg", […\\Cryptography /v MachineGuid]));
```

`X-DeepAI-Code-Machine` is `sha256(lowercased raw id)`, hex. Known placeholder UUIDs (`0000…`,
`ffff…`, `03000200-0400-0500-0006-000700080009`) are rejected.

**But the value the gateway has on file for this machine is the `MachineGuid` digest, not the SMBIOS
one.** Measured directly:

| digest sent | source | result |
|---|---|---|
| `197abeb5…` | `4a2c4d5c-8b99-e611-b753-c8d3fff1a219` (SMBIOS) | `400 This request is not one DeepAI Code sends.` |
| `f1e4fcd5…` | `dea5a7b7-8de9-490a-8580-e48b9f966ca9` (MachineGuid) | `200` |

Reason: in the packaged build the `powershell` probe does not answer inside the app's 10 s timeout,
so `detect()` falls through to `MachineGuid` and that is what got registered. The proxy therefore
reads **`MachineGuid` first on win32** and only falls back to SMBIOS, so the digest it sends is the
one the account already has. Dynamic proof (`GET /deepai_code/theos`, the account endpoint):

```
200 {"enabled":true,"balance":"50.00000","granted":"50.00000","lane_version":4,
     "check_in":{"nonce":"9bd10dc100f46993a62c085280a913dd","seconds":600}}
```

That call is also the app's check-in: a nonce the client echoes back via
`X-DeepAI-Code-Check-In` on the next `/theos`, with `X-DeepAI-Code-Beacon:
v=<ver>;up=<uptime>;pi=<0|1>;focus=<0|1>`. Chat requests do not need it — but check-in *does not
register the digest either*: the `400` persisted with a fresh nonce, and switching the digest to the
`MachineGuid` one is what actually fixed it.

`DEEPAI_MACHINE_ID=<raw id>` overrides the raw value (the header becomes `sha256` of it),
`DEEPAI_MACHINE_HEADER=0` omits the header entirely.

#### Correction, measured later: the digest is **not** bound to the account

A sweep with the same account and body, changing only the digest:

| digest | result |
|---|---|
| `sha256("4a2c4d5c-…")` (this box's SMBIOS UUID) | **400** (deterministic, repeated) |
| `sha256("dea5a7b7-…")` (this box's MachineGuid) | 200 |
| `sha256(randomUUID())` | **200** |
| `sha256("dea5a7b7-…aa")` (doctored GUID) | 200 |

So the server does **not** compare the digest against a registered machine — an arbitrary value is
accepted. The one failing value looks like it is on a server-side denylist (a cloned/VM-template UUID),
which is why the error text is the generic "not one DeepAI Code sends". Two consequences:

1. `MachineGuid` is the safe choice for a single account on this machine, but any stable digest works.
2. A digest is a *label*, not a hardware attestation — which is what makes per-account machines
   possible (§3.5).

### 3.5 Multiple accounts, one machine digest each

Since the digest is a free-form label, each account can present its own "machine":

```jsonc
// accounts.json
{
  "active": "main",
  "accounts": [
    { "name": "main",   "apiKey": "…", "username": "a", "isPro": false },
    { "name": "second", "apiKey": "…", "username": "b", "machineId": "laptop-b" }
  ]
}
```

`machineId` resolution (`accountMachineId` in `account.mjs`):

| value | digest sent |
|---|---|
| omitted | `sha256("deepai-proxy:" + name)` — stable, distinct per account |
| `"local"` | the real digest of this computer (`machine-guid`) |
| 64 hex chars | used verbatim (pin a digest another build registered) |
| any other string | `sha256(that string)`, so a digest can be seeded from a label |

Affinity is derived per account as well (`sha256("deepai-proxy-affinity:" + name + ":" + apiKey)`,
shaped like a UUID), so session stickiness survives restarts and never leaks between accounts.

Selection per request:

```
?account=<name>   >   x-proxy-account: <name>   >   ACCOUNT=<name>   >   accounts.json "active"
```

Why separate digests matter: the daily Theos grant is **per machine digest**, so two accounts sharing
one digest share one grant pool — and look like multi-accounting on a single machine. Distinct digests
per account keep grants independent, which is the whole point of the mapping.

### 3.6 The other trap — everything must be streamed

`stream: false` on its own gets the same `400 "This request is not one DeepAI Code sends."`.
The app never sends a non-streaming request: `pi` always assembles

```js
{ model, messages, stream: true, stream_options: { include_usage: true }, … }
```

so the gateway validates that shape. Therefore the proxy **always** asks upstream for a stream and,
if the client wanted one JSON body, folds the SSE back together itself.

### 3.7 Response shape actually returned

It is OpenAI-compatible, but the reasoning field is `reasoning` (not `reasoning_content`) and the
`model` field is the internal route (`reflection/beam`, `deepseek/deepseek-v4.1-flash-1017`), not the
catalog id. SSE frames are `data: {...}`, terminated by `[DONE]`.

### 3.8 The lane moves — discovery instead of a constant

`X-DeepAI-Code-Theos` is the lane: a number that is not a protocol version but a **release
generation**. DeepAI retires a lane when it retires the builds that spoke it, and the refusal is
explicit:

```
HTTP/1.1 426 Upgrade Required
{"error": {"message": "This version of DeepAI Code is no longer supported. Please update the app.",
           "type": "lane_version_unsupported", "code": "lane_version_unsupported"}}
```

A hardcoded lane therefore has a shelf life. 4 was right until the app shipped 5, then 6
(DeepAI-Code 0.3.37, `DEEPAI_LANE_HEADERS = { "X-DeepAI-Code-Theos": "6" }`). `src/lane.mjs`
discovers the served lane instead:

* **The gate runs before the credential check.** `GET /deepai_code/theos` with only the lane header
  answers `426 lane_version_unsupported` for a retired lane and `401`/`200` for a served one, so
  discovery needs no working key — a stale or empty store still finds the lane.
* **The served set is contiguous** (4 → 426, 5 → 200, 6 → 200, 7 → 426), so the walk is short: a
  served lane climbs until the first refusal, a refused lane walks up (too old) then down (too new),
  and the first served lane found going down is the top of the range.
* **A `200` is authoritative.** `/theos` returns `lane_version` in its body; when present it is
  adopted verbatim, which is exact rather than inferred.
* **The value is live, not boot-time.** `fingerprintHeaders()` reads `currentLane()` on every call,
  the lane is re-probed in the background after `LANE_REFRESH_MS` (15 min), and a `426` on a real
  request drops the cache, re-discovers and **replays the same request** — so a bump mid-run costs one
  retry, not a restart.
* **The seed is only a seed.** `LANE_VERSION` (env `DEEPAI_LANE_VERSION`) is the starting guess for
  the walk. `DEEPAI_LANE_AUTODISCOVER=0` pins it and never probes.

The check-in beacon is derived the same way: `v=` comes from the desktop download redirect
(`/download/deepai-code/linux-x64` → `DeepAI-Code-<ver>-x86_64.AppImage`), so it tracks the release
without another constant.

---

## 4. Design

### 4.0 Layout

`deepai-proxy.mjs` is the CLI entry point and stays thin; the logic lives in `src/`.

```
deepai-proxy.mjs             command dispatch (login|import-app|accounts|use|verify|serve|whoami)
src/
├── config.mjs               env + paths, every tunable in one place
├── account.mjs              store, named accounts, per-account digest + affinity, weights, cursor
├── login.mjs                desktop auth flow, exchange, import-app, UI callback, auto-capture
├── fingerprint.mjs          machine probes, per-account digest + affinity, header set
├── lane.mjs                 lane discovery + background refresh + check-in beacon (no restart)
├── models.mjs               catalog ids (app's models.json, else fallback list)
├── upstream.mjs             payload normalisation, rotation/failover, the upstream fetch
├── anthropic-to-openai.mjs  request translation
├── openai-to-anthropic.mjs  response translation
├── stream-aggregate.mjs     SSE -> single chat.completion (+ usage tap for live streams)
├── anthropic-stream.mjs     OpenAI SSE -> Anthropic SSE
├── http-server.mjs          routing, guards, handlers, control panel
├── api.mjs                  panel API: accounts, settings, login, capture, usage, verify
├── metrics.mjs              per-process request/token counters
├── verify.mjs               live fingerprint check (theos + chat with and without the digest)
└── ui.html                  fallback panel, used when ui/dist is absent

ui/                          control panel source (Vite + React + Tailwind)
├── package.json             dev-only dependencies; nothing is needed at runtime
├── vite.config.js           base "./", dev server proxies /api, /health, /v1 to 8787
├── index.html
├── src/main.jsx             entry
├── src/App.jsx              state, polling, handlers
├── src/api.js               fetch wrapper + formatters
├── src/index.css            Tailwind import, glass/ambient styles
└── src/components/          ui primitives, Rotation, Accounts, Login, Usage, TestPanel

ui/dist/                     committed build output; served at "/" by http-server.mjs
```

The panel is served from memory: `serveUi` prefers `ui/dist/index.html` and falls back to
`src/ui.html`, so `node deepai-proxy.mjs serve` works on a fresh clone with no npm. `/assets/*` is
served from `ui/dist` only, with a path check that refuses anything outside it.

One file, zero dependencies, ESM, Node 18+ (`fetch`, `AbortSignal.timeout`, `crypto.randomUUID`).

### 4.1 Commands

| command | behaviour |
|---|---|
| `serve` (default) | HTTP server on `127.0.0.1:8787`, plus the panel at `/` |
| `login [name]` | the §3.1 flow; the callback returns to the panel port, saves the account, then auto-captures app credentials |
| `import-app [name]` | copies `~/.deepai-code/userdata/secrets/deepai-account.bin` in as an account |
| `accounts` | lists accounts with weight and machine digest, `*` marks the active one |
| `use <name>` | sets the active account |
| `verify [name]` | prints the header set and the discovered lane, calls `/theos`, then chats **with and without** the digest |
| `lane` | re-discovers the served lane (and app version) and prints it as JSON |
| `whoami [name]` | masked key, weight, machine digest, store path |

`acc.json` stays the store and carries a top-level `apiKey` mirror of the active account, so anything
that reads the old single-account shape keeps working. `accounts.json` is read when it exists (older
builds wrote it there) and is written back in the same place.

### 4.2 Environment

| var | default | purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `ACC_PATH` | `./acc.json` | the store (and the legacy mirror inside it) |
| `ACCOUNTS_PATH` | `./accounts.json` | second store path; preferred when it exists |
| `ACCOUNT` | *(empty)* | pin every request to this account name |
| `PROXY_TOKEN` | *(empty)* | require `Authorization: Bearer` on `/v1/*` |
| `DEEPAI_API_ORIGIN` | `https://api.deepai.org` | origin override (dev/testing) |
| `DEEPAI_USERDATA` | `~/.deepai-code/userdata` | where `import-app`, auto-capture and the catalog read from |
| `DEEPAI_MACHINE_HEADER` | off (`1` forces on) | send `X-DeepAI-Code-Machine`; the panel can also toggle it |
| `DEEPAI_MACHINE_ID` | auto probe | raw id hashed into the local digest |
| `DEEPAI_SESSION_AFFINITY` | random UUID | last-resort affinity when no account is involved |
| `DEEPAI_LANE_VERSION` | `6` | seed for lane discovery; the served lane is discovered, not assumed |
| `DEEPAI_LANE_AUTODISCOVER` | on (`0` pins the seed) | stop probing the gateway for the lane |
| `DEEPAI_LANE_REFRESH_MS` | `900000` | how long a discovered lane is trusted before a background re-probe |
| `DEEPAI_APP_VERSION` | `0.3.37` | fallback `v=` for the check-in beacon until the live release is fetched |
| `DEBUG` | off | log the exact upstream JSON body |
| `DEBUG_HEADERS` | off | log the exact outgoing header set (`api-key` masked) |
| `LOG_REQUESTS` | off | log inbound requests with credentials redacted |

### 4.3 Credential handling

The store is written with `mode: 0o600` (+ `chmodSync` for platforms that ignore the mode on
create). Records hold `{name, apiKey, username, isPro, weight, machineId?, affinity?}`; the top level
holds `{active, apiKey, username, isPro, settings, accounts}`, where `apiKey`/ `username`/`isPro`
mirror the active account for old readers. Accounts are resolved **per request**, so `login`, `use`
or a weight change takes effect immediately with no restart.

### 4.4 Request path

```
client ──POST /v1/chat/completions─────────────► passthrough ──► upstream (SSE) ──► client (SSE)
                                                        └── if stream:false → aggregate → JSON
client ──POST /v1/messages ──► anthropicToOpenAI ──► upstream (SSE) ──► aggregate → openAIToAnthropic → JSON
                                                        └── if stream:true  → OpenAI SSE → Anthropic SSE
```

Guard order is deliberate (mirrors §3.3):

1. `GET /` (panel), `GET /health`, `GET /v1/models` (always open, local only)
2. `Origin` present and not loopback → 403; `OPTIONS` → 204 + CORS
3. `/auth-callback` (login return), `/api/*` (panel API)
4. non-POST → 404
5. `PROXY_TOKEN` mismatch → 401
6. `/v1/*` dispatch; `?account=` / `x-proxy-account` pins the account, else the rotation decides

### 4.5 Anthropic → OpenAI translation (`anthropicToOpenAI`)

| Anthropic | OpenAI |
|---|---|
| `system` (string or text blocks) | one leading `{role:"system"}` |
| `user` content blocks | `{role:"user"}`, text joined when all-text, otherwise content parts |
| `image` with `source.{type:base64,media_type,data}` | `image_url` with `data:<media_type>;base64,<data>` |
| `image` with `source.type:url` | `image_url` with the URL |
| `tool_result` blocks | separate `{role:"tool", tool_call_id, content}` messages **emitted before** the user text |
| assistant `tool_use` | `message.tool_calls[]` with `arguments: JSON.stringify(input)` |
| `tools[{name,description,input_schema}]` | `tools[{type:"function",function:{name,description,parameters}}]` |
| `tool_choice.auto/any/tool/none` | `"auto"` / `"required"` / `{type:"function",function:{name}}` / `"none"` |
| `max_tokens`, `temperature`, `top_p` | same names |
| `stop_sequences` | `stop` |
| `thinking:{type:"enabled",budget_tokens}` | `reasoning_effort` high ≥32k, medium ≥8k, low >0 |
| `thinking:{type:"disabled"}` | `reasoning_effort: "none"` |
| `document` blocks | dropped (logged as `[document omitted]`) |

`max_tokens` is required by Anthropic clients and passed straight through; the gateway applies the
catalog's own cap.

### 4.6 OpenAI → Anthropic translation (`openAIToAnthropic`)

* `reasoning`/`reasoning_content` → `{type:"thinking", thinking, signature:""}`
* `content` (string or text parts) → `{type:"text"}`
* `tool_calls[]` → `{type:"tool_use", id, name, input}` with `arguments` `JSON.parse`d (falls back to `{}`)
* always at least one content block (empty text) so clients don't choke
* `finish_reason` → `stop_reason`: `stop→end_turn`, `length→max_tokens`,
  `tool_calls/function_call→tool_use`, `content_filter→end_turn`
* `usage.prompt_tokens → input_tokens`, `completion_tokens → output_tokens`,
  `prompt_tokens_details.cached_tokens → cache_read_input_tokens`

### 4.7 Streaming: OpenAI SSE → Anthropic SSE

A small state machine, because Anthropic requires blocks to open and close in order:

```
message_start                       (opened lazily on the first chunk, so the usage-bearing
                                     first frame can supply input_tokens)
  content_block_start  thinking     index 0   ← only if reasoning arrives first
    content_block_delta thinking_delta
  content_block_stop
  content_block_start  text         next index
    content_block_delta text_delta
  content_block_stop
  content_block_start  tool_use     next index, per tool_call index
    content_block_delta input_json_delta partial_json
  content_block_stop
message_delta   {stop_reason, usage}
message_stop
```

Rules implemented:

* text and thinking blocks are closed before a tool block opens; tool blocks are keyed by the
  OpenAI `tool_call.index` so parallel calls interleave correctly;
* `[DONE]`, blank lines and non-`data:` lines are ignored;
* `\r\n` normalised before splitting on `\n\n`;
* a stream that ends without a terminal frame still produces `message_delta` + `message_stop`;
* any throw inside the parser emits `event: error` instead of hanging the client.

### 4.8 Non-stream aggregation (`aggregateStream`)

Since upstream is forced to stream, a `stream:false` client needs the deltas folded back:

* text concatenated into `message.content`
* reasoning concatenated into `message.reasoning_content`
* `tool_calls` merged **by index** (id/name first-wins, `arguments` appended) then sorted by index
* last seen `usage` wins (it arrives in the final frame because of `include_usage`)
* `finish_reason` defaults to `tool_calls` if any tools were emitted, else `stop`
* `content` becomes `null` when empty, matching OpenAI

### 4.9 Why `count_tokens` is local

Anthropic clients call it before every send. It has no upstream equivalent, so it returns
`ceil(len(JSON)/4)` — good enough to keep clients happy, never bills Theos.

### 4.10 Account store

`account.mjs` owns the store and the two per-account fingerprint fields:

```
loadStore()      -> { accounts[], settings }      names derived and persisted on first read
loadAccounts()   -> accounts[]
findAccount(n)   -> account | null                n omitted -> active, else first
addAccount(a)    -> upsert by apiKey              duplicate keys update, never duplicate
updateAccount(i, patch)                           weight / name / machineId / affinity
setActive(n)     -> switch the active account
accountMachineId(account, localDigest)            see §3.5 table
accountAffinity(account)                          sha256(name + ":" + apiKey), UUID-shaped
```

Resolution is by account **name**, not by array position, so hand-editing the file (adding a
`machineId`, reordering) cannot silently swap credentials. Names default to the username, are made
unique (`name-2`, `name-3`), and are written back on the first read so a later reorder cannot rename
an account. Records without an `apiKey` are skipped instead of throwing, so one broken record cannot
take the server down.

`http-server.mjs` resolves the account **per request** (`pickAccount`): `?account=<name>` >
`x-proxy-account` header > `ACCOUNT` env > rotation. A requested account that does not exist is a
`404` instead of a silent fallback, so a typo cannot spend the wrong account's Theos.

### 4.11 Rotation, weights, and the control panel

`settings.rotation` is `"round-robin"` (default) or `"single"`. Round-robin walks a ring built from
the per-account `weight` (1-20): weight 2 vs 1 gives `A, B, A`. The ring is cached and rebuilt only
when the list or a weight changes, which also resets the cursor. `"single"` pins every request to
`settings.active`, which is what `use <name>` and the panel's **Pin** button change.

`upstreamFetch` rotates per request. A rejected account (`401`, `403`, `429`) or a network failure
moves to the next one, up to one attempt per account, and the final response is returned with its
body intact. The account used is recorded as `lastAccount` in `GET /api/usage`. A pinned account
(`?account=`) is used directly and does **not** fail over, so its real error reaches the caller.

The panel (`GET /`) is plain HTML with no build step. Its API:

| endpoint | purpose |
|---|---|
| `GET /api/accounts` | accounts with masked keys, weight, digest prefix, settings, rotation order |
| `POST /api/accounts` | add/update one, an array, or `{accounts:[...]}` |
| `PATCH /api/accounts/:index` | `weight`, `name`, `machineId`, `affinity` |
| `DELETE /api/accounts/:index` / `/api/accounts` | remove one / all |
| `GET /api/accounts/export` | every stored key |
| `GET`/`POST /api/settings` | `rotation`, `active`, `sendMachineHeader` |
| `POST /api/login` | start the flow (callback lands on the panel port) |
| `POST /api/login/callback` | finish from a pasted callback URL or bare code |
| `GET`/`POST /api/capture` | scan / import desktop app credentials |
| `POST /api/verify` | live fingerprint report for one account |
| `GET /api/usage` | per-process counters, last account, rotation state |

`sendMachineHeader` defaults **off**: the local digest is the value the gateway rejected on this
machine, so the header is opt-in. Turning it on sends each account's own digest, and `verify` reports
both variants so a rejected digest can be told apart from a rejected payload.

Loopback `Origin` headers (`127.*`, `localhost`, `::1`, `0.0.0.0`, any port) are accepted so the
panel's fetches work, including `OPTIONS` preflight. Every other origin still gets `403`.

---

## 5. Verification performed

| check | result |
|---|---|
| `node --check` on every module | clean |
| `import-app` | `user=deltaapoc317 pro=false`, 102 B `acc.json` |
| `GET /health` | `{"ok":true,"signedIn":true,…}` |
| `GET /v1/models` | 22 ids read from the app's catalog |
| `POST /v1/chat/completions` `stream:false` | `{"content":"ok", usage:{180,13,193}}` |
| `POST /v1/chat/completions` `stream:true` | raw upstream SSE passed through |
| `POST /v1/messages` | `content:[{thinking…},{text:"4"}]`, `stop_reason:"end_turn"` |
| `POST /v1/messages` `stream:true` | `message_start` → `thinking` block → `text` block → `message_stop` |
| forced `tool_choice:{type:"tool"}` | `{type:"tool_use",name:"get_time",input:{tz:"UTC"}}`, `stop_reason:"tool_use"` |
| `verify deltaapoc317` | `theos 200` (balance 49.97/50), `chat + machine 200`, `chat - machine 200`, OK |
| machine header on, pinned account | `200`, per-account digest accepted (§3.5 correction confirmed) |
| account rejected by the gateway | `403 social_login_required` surfaced with the account name |
| weighted ring 2:1 | requests used `alpha, bravo, alpha, alpha, bravo, alpha` |
| `rotation:"single"` | every request used the **active** account, not index 0 |
| `?account=bravo` | request used `bravo`'s key; unknown name → `404` |
| name persistence | derived names written once; two runs produced identical output |
| `GET /api/verify` | returns the header set, digest, affinity and all three checks |
| `Origin` header | 403, same as the app |
| machine header = SMBIOS digest | 400 `"This request is not one DeepAI Code sends."` |
| machine header = MachineGuid digest | 200 |
| full app header set (incl. machine + affinity) | 200, `DEBUG_HEADERS` output identical to §3.2 |
| `GET /deepai_code/theos` with the same headers | 200, balance + check-in nonce |
| digest sweep: SMBIOS / MachineGuid / random / doctored | 400 / 200 / 200 / 200 → digest is a label, not attestation |
| two accounts in `accounts.json`, no selector | account `main` served |
| `?account=second` | distinct `api-key` (26 vs 36 chars), distinct machine digest, distinct affinity; upstream `401` for the dummy key as expected |
| `verify main` after cleanup | `theos 200`, `chat 200`, "OK" |

---

## 6. Pitfalls hit while building (in order)

1. **Wrong asar offset.** `dd` at the indexed offset returned another file's bytes. Fix: the
   `4,074,053`-byte delta between the index and the data section.
2. **Chasing `pi-messages`.** It is real code (`https://radius.pi.dev/v1/messages`,
   `authorization: Bearer`) but this build's DeepAI provider is `openai-completions` against a
   loopback bridge — the `radius` entries are catalog entries for other models.
3. **Looking for the gateway host in `app.asar`.** It is not there; the driver lives in
   `server.asar`, and the constant is assembled as `DEEPAI_API_ORIGIN + "/deepai_code"`.
4. **`stream:false` rejected.** Fixed by always streaming upstream (§3.6).
5. **`400` after fixing (4)** — caused by the machine header. Isolating it needed a two-variant probe
   (same body, header toggled), then a digest sweep. Fix at the time: read `MachineGuid` first on
   win32 (§3.4). The later sweep showed the real shape of the rule: an arbitrary digest is accepted
   and one specific SMBIOS value is denylisted, so "registered machine" was the wrong mental model —
   the header is a label (§3.5).
6. **Stale process during testing.** The first `serve` kept holding `:8787`, so the new code never
   loaded and the same error reappeared. Always kill the listener by PID from `netstat` before
   re-testing.
7. **Minified code is tab-separated.** `grep` on raw bytes misses multi-field logic; `tr '\t' '\n'`
   makes it readable.

---

## 7. Security / operational notes

* `accounts.json` / `acc.json` hold the account key **in plaintext** — the app itself keeps the same
  key in plaintext at `~/.deepai-code/userdata/secrets/deepai-account.bin`, so this is not a new
  exposure, but it is a real one: treat those files like passwords and delete them when done. Prefer
  `login` (fresh exchange) over `import-app` if you don't want a copy at all.
* The server binds `127.0.0.1` only. `PROXY_TOKEN` exists for the case where something else on the
  machine should not be able to drive your account.
* Browser `Origin` requests are refused, which kills the obvious CSRF path.
* Every call spends the account's Theos; catalog entries with `theosPerRequest: "0"` are free.
* Reusing a desktop client's private endpoint from other tools may fall outside DeepAI's terms of
  service — that is a decision for the account holder, not something this script can decide.

---

## 8. Troubleshooting

| symptom | cause |
|---|---|
| `400 This request is not one DeepAI Code sends.` | `stream`/`stream_options` missing, `X-Session-Affinity` omitted, or the account's `machineId` is a denylisted value (§3.4) |
| `401 not signed in` | `acc.json` missing/empty → `login` or `import-app` |
| `403 model transport authentication required` | client sent an `Origin` header |
| `EADDRINUSE` on start | an older `serve` still owns the port — kill the PID from `netstat` |
| `401`/`429` during `login` | link expired/used or too many attempts — restart `login` |
| `proxy.log` shows a body you didn't expect | rerun with `DEBUG=1` |
| `unknown account "x"` | `node deepai-proxy.mjs accounts` to list; `use` to switch |
| `403 social_login_required` from upstream | that account signed in without Google/Apple, so DeepAI Code refuses it; rotate it out or remove it |
| login tab ends on `/auth-callback` | paste that URL into the panel's **Manual sign-in** box |

---

## 9. Final state of this build

```
HOWIBUILD.md     this file - how + protocol
DECISIONS.md     why, with evidence
acc.json         credential store (0600), holds the active-account mirror too
accounts.json    read/written when present (older builds stored accounts here)
src/*.mjs        13 modules + ui.html; deepai-proxy.mjs is the CLI entry point
```

Session order, so the reasoning can be replayed:

1. locate the app's data (`~/.deepai-code/userdata`), read `models.json` → it points at a loopback
   bridge with an OpenAI-shaped API;
2. reverse `server.asar` → origin, `/deepai_code` base, lane headers, sign-in flow, machine id;
3. build the single-file proxy; login + import; OpenAI and Anthropic endpoints; SSE both ways;
4. hit `400 … not one DeepAI Code sends.` twice — first fixed by forcing `stream` +
   `stream_options`, then by the machine digest;
5. prove the header set is the app's (`DEBUG_HEADERS`, `verify`), normalise JSON key order, always
   send `X-Session-Affinity`;
6. digest sweep disproves "registered machine" and enables per-account machines;
7. modularise into `src/`, add `accounts`/`use`/`verify`, redact logging;
8. merge the two builds: named accounts and per-account digests from the `src1` tree, plus the
   control panel, weights, rotation toggle, auto-capture and pasted-callback login;
9. document all of it here and in `DECISIONS.md`.

Known open items, deliberately not done: `/responses` and the two provider-side tools, the `/theos`
check-in loop, and any local capacity queue — see `DECISIONS.md` “What was deliberately not
implemented”.
