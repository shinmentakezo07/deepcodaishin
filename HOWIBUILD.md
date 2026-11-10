# HOW I BUILT `deepai-proxy.mjs`

A record of how the proxy was reverse-engineered from the DeepAI Code desktop app, what the
protocol actually is, and why every line of the proxy exists.

Everything below was verified against the installed app on this machine
(`C:\Users\shinm\AppData\Local\Programs\deepai-code-desktop`, version from 2026-11-10) and by live
calls to the real gateway.

---

## 1. The goal

A local Node service that:

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
X-DeepAI-Code-Theos: 4
X-DeepAI-Code-Instance: <32 hex>
X-DeepAI-Code-Machine: <sha256(machine uuid)>          (see §3.4 — not sent by default)
api-key: <account api key>
X-Session-Affinity: <optional, [A-Za-z0-9._:-]{1,256}>

{"model":"…","messages":[…],"stream":true,"stream_options":{"include_usage":true}, …}
```

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

### 3.4 The machine header — the trap

`X-DeepAI-Code-Machine` is `sha256` of the raw machine identifier, lowercased:

| platform | source |
|---|---|
| win32 | `(Get-CimInstance Win32_ComputerSystemProduct).UUID`, else `HKLM\SOFTWARE\Microsoft\Cryptography` → `MachineGuid` |
| darwin | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` |
| linux | `/sys/class/dmi/id/product_uuid`, else `/etc/machine-id` |

Known placeholder UUIDs (`0000…`, `ffff…`, `03000200-0400-0500-0006-000700080009`) are rejected, and
a firmware placeholder falls back to `MachineGuid`. The raw id never leaves the machine.

**But sending it to the gateway from a non-app process fails:**

```
with machine header      → 400 {"error":{"message":"This request is not one DeepAI Code sends."}}
without machine header   → 200 SSE
```

The gateway only accepts a digest it has already registered (the app registers it through its
`/theos` check-in). So `SEND_MACHINE_HEADER` defaults to **false** and the header is opt-in via
`DEEPAI_MACHINE_HEADER=1`. The digest is still computed and reported in `GET /health`.

### 3.5 The other trap — everything must be streamed

`stream: false` on its own gets the same `400 "This request is not one DeepAI Code sends."`.
The app never sends a non-streaming request: `pi` always assembles

```js
{ model, messages, stream: true, stream_options: { include_usage: true }, … }
```

so the gateway validates that shape. Therefore the proxy **always** asks upstream for a stream and,
if the client wanted one JSON body, folds the SSE back together itself.

### 3.6 Response shape actually returned

It is OpenAI-compatible, but the reasoning field is `reasoning` (not `reasoning_content`) and the
`model` field is the internal route (`reflection/beam`, `deepseek/deepseek-v4.1-flash-1017`), not the
catalog id. SSE frames are `data: {...}`, terminated by `[DONE]`.

---

## 4. Design of `deepai-proxy.mjs`

Zero dependencies, ESM, Node 18+ (`fetch`, `AbortSignal.timeout`, `crypto.randomUUID`). The entry point stays a thin CLI; the logic lives in `src/`:

| module | responsibility |
|---|---|
| `deepai-proxy.mjs` | CLI dispatch (`login`, `import-app`, `serve`, `whoami`) |
| `src/config.mjs` | env vars, paths, upstream constants |
| `src/fingerprint.mjs` | machine id + lane/instance headers |
| `src/account.mjs` | load/save/require `acc.json` |
| `src/login.mjs` | `desktop_auth` exchange + `import-app` |
| `src/models.mjs` | catalog + fallback model ids |
| `src/upstream.mjs` | forced-stream upstream request |
| `src/anthropic-to-openai.mjs` | Anthropic request → OpenAI request |
| `src/openai-to-anthropic.mjs` | OpenAI response → Anthropic response + stop map |
| `src/stream-aggregate.mjs` | fold SSE into one completion |
| `src/anthropic-stream.mjs` | OpenAI SSE → Anthropic SSE |
| `src/http-server.mjs` | routing, guards, handlers |

### 4.1 Commands

| command | behaviour |
|---|---|
| `serve` (default) | HTTP server on `127.0.0.1:8787` |
| `login` | the §3.1 flow; binds an ephemeral port, prints + opens the URL, saves `acc.json` |
| `import-app` | copies `~/.deepai-code/userdata/secrets/deepai-account.bin` → `acc.json` |
| `whoami` | prints username/isPro/masked key/machine digest |

### 4.2 Environment

| var | default | purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `ACC_PATH` | `./acc.json` | credential file |
| `PROXY_TOKEN` | *(empty)* | require `Authorization: Bearer` on this proxy |
| `DEEPAI_API_ORIGIN` | `https://api.deepai.org` | origin override (dev/testing) |
| `DEEPAI_USERDATA` | `~/.deepai-code/userdata` | where `import-app` and the catalog read from |
| `DEEPAI_MACHINE_HEADER` | off | send the machine digest (§3.4) |
| `DEBUG` | off | log the exact upstream body |

### 4.3 Credential handling

`acc.json` is written with `mode: 0o600` (+ `chmodSync` for platforms that ignore the mode on
create) and only ever holds `{apiKey, username, isPro}`. `loadAccount()` is called **per request**, so
re-running `login` while the server is up takes effect immediately with no restart.

### 4.4 Request path

```
client ──POST /v1/chat/completions─────────────► passthrough ──► upstream (SSE) ──► client (SSE)
                                                        └── if stream:false → aggregate → JSON
client ──POST /v1/messages ──► anthropicToOpenAI ──► upstream (SSE) ──► aggregate → openAIToAnthropic → JSON
                                                        └── if stream:true  → OpenAI SSE → Anthropic SSE
```

Guard order is deliberate (mirrors §3.3):

1. `GET /health`, `GET /v1/models` (always open, local only)
2. non-POST → 404
3. `Origin` header present → 403
4. `PROXY_TOKEN` mismatch → 401
5. route dispatch

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

---

## 5. Verification performed

| check | result |
|---|---|
| `node --check` | clean |
| `import-app` | `user=deltaapoc317 pro=false`, 102 B `acc.json` |
| `GET /health` | `{"ok":true,"signedIn":true,…}` |
| `GET /v1/models` | 22 ids read from the app's catalog |
| `POST /v1/chat/completions` `stream:false` | `{"content":"ok", usage:{180,13,193}}` |
| `POST /v1/chat/completions` `stream:true` | raw upstream SSE passed through |
| `POST /v1/messages` | `content:[{thinking…},{text:"4"}]`, `stop_reason:"end_turn"` |
| `POST /v1/messages` `stream:true` | `message_start` → `thinking` block → `text` block → `message_stop` |
| forced `tool_choice:{type:"tool"}` | `{type:"tool_use",name:"get_time",input:{tz:"UTC"}}`, `stop_reason:"tool_use"` |
| `Origin` header | 403, same as the app |
| machine header on | 400 `"This request is not one DeepAI Code sends."` |
| machine header off | 200 |

---

## 6. Pitfalls hit while building (in order)

1. **Wrong asar offset.** `dd` at the indexed offset returned another file's bytes. Fix: the
   `4,074,053`-byte delta between the index and the data section.
2. **Chasing `pi-messages`.** It is real code (`https://radius.pi.dev/v1/messages`,
   `authorization: Bearer`) but this build's DeepAI provider is `openai-completions` against a
   loopback bridge — the `radius` entries are catalog entries for other models.
3. **Looking for the gateway host in `app.asar`.** It is not there; the driver lives in
   `server.asar`, and the constant is assembled as `DEEPAI_API_ORIGIN + "/deepai_code"`.
4. **`stream:false` rejected.** Fixed by always streaming upstream (§3.5).
5. **`400` after fixing (4)** — caused by the machine header (§3.4), isolated with a two-variant
   probe.
6. **Stale process during testing.** The first `serve` kept holding `:8787`, so the new code never
   loaded and the same error reappeared. Always kill the listener by PID from `netstat` before
   re-testing.
7. **Minified code is tab-separated.** `grep` on raw bytes misses multi-field logic; `tr '\t' '\n'`
   makes it readable.

---

## 7. Security / operational notes

* `acc.json` is a **plaintext** copy of the account key — the app itself keeps the same key in
  plaintext at `~/.deepai-code/userdata/secrets/deepai-account.bin`, so this is not a new exposure,
  but it is a real one: treat the file like a password, and `rm acc.json` when done. Prefer `login`
  (fresh exchange) over `import-app` if you don't want a copy at all.
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
| `400 This request is not one DeepAI Code sends.` | `stream`/`stream_options` missing, or machine header sent unregistered |
| `401 not signed in` | `acc.json` missing/empty → `login` or `import-app` |
| `403 model transport authentication required` | client sent an `Origin` header |
| `EADDRINUSE` on start | an older `serve` still owns the port — kill the PID from `netstat` |
| `401`/`429` during `login` | link expired/used or too many attempts — restart `login` |
| `proxy.log` shows a body you didn't expect | rerun with `DEBUG=1` |
