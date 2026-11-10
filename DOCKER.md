# Running deepai-proxy in Docker

The image runs on **Node 22 (alpine)** with **zero npm dependencies at runtime**.
The React/Vite/Tailwind control panel is prebuilt in `ui/dist` and copied into
the image, so no `npm install` or toolchain is needed at build or run time.
It serves OpenAI- and Anthropic-compatible endpoints plus the panel at `/`.

## What you need

- A credential store (`acc.json`, optionally `accounts.json`) containing plaintext
  API keys. These are **not baked into the image** - mount them at runtime and
  treat them like passwords.
- Docker Engine with Compose v2 (`docker compose`).

## Quick start

```bash
# 1. Create a credential store on the host (or use the panel after startup):
node deepai-proxy.mjs login          # or: node deepai-proxy.mjs import-app

# 2. Build and start:
docker compose up -d --build

# 3. Verify:
curl http://127.0.0.1:8787/health
curl -s -o /dev/null -w 'panel %{http_code}\n' http://127.0.0.1:8787/
curl http://127.0.0.1:8787/v1/models
docker compose ps                   # STATUS should be "healthy"
```

Open the control panel at **http://127.0.0.1:8787/**. It manages accounts,
weights, the round-robin/single toggle, the machine header, sign-in, import/export,
usage counters, and a test request.

## docker build / docker run

```bash
docker build -t deepai-proxy:local .

docker run -d --name deepai-proxy \
  -p 127.0.0.1:8787:8787 \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  -e ACC_PATH=/data/acc.json \
  -v "$(pwd)/acc.json:/data/acc.json" \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  deepai-proxy:local
```

## Configuration

| Variable | Default (container) | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address inside the container (host publish stays loopback) |
| `PORT` | `8787` | Listen port; also the login callback port |
| `ACC_PATH` | `/data/acc.json` | Credential store (also the active-account mirror) |
| `ACCOUNTS_PATH` | `/data/accounts.json` | Named-account store, read/written when present |
| `DEEPAI_USERDATA` | `/data/userdata` | Desktop-app data for `Auto-capture` and the model catalog |
| `ACCOUNT` | *(active)* | Default account name for requests without `?account=` |
| `PROXY_TOKEN` | *(empty)* | Require `Authorization: Bearer <token>` on `/v1/*` |
| `DEEPAI_API_ORIGIN` | `https://api.deepai.org` | Upstream origin override |
| `DEEPAI_MACHINE_HEADER` | off | Send per-account `X-DeepAI-Code-Machine` (`1` enables; the panel can toggle it) |
| `DEEPAI_MACHINE_ID` | auto probe | Raw id hashed into the local machine digest |
| `VERIFY_MODEL` | `deepseek-v4.1-flash` | Model used by `verify` |
| `LOG_REQUESTS` | off | Log inbound requests (credentials redacted) |
| `DEBUG` | off | Log exact upstream JSON bodies |
| `DEBUG_HEADERS` | off | Log outgoing header set (`api-key` masked) |
| `ALLOWED_ORIGINS` | *(empty)* | Extra browser origins allowed to call the panel API, comma separated. Same-origin is always allowed, so this is only for a second hostname in front of the platform one |

Per-request account selection: `?account=<name>` > `x-proxy-account` header >
`ACCOUNT` env > rotation. See `README.md` / `HOWIBUILD.md` for the full protocol.

## Control panel

The image serves `ui/dist/index.html` at `/` and `ui/dist/assets/*` (JS, CSS and
two self-hosted `woff2` fonts) at `/assets/*`. `ui/node_modules`, `ui/src`, the
Vite config and the npm lockfile are excluded by `.dockerignore` - they are build
inputs, not runtime files. If `ui/dist` is ever absent the proxy falls back to
the single-file panel in `src/ui.html`.

After editing `ui/src`, rebuild and recreate the container:

```bash
cd ui && npm install && npm run build
cd .. && docker compose up -d --build
```

## Notes & caveats

- **Same-origin behind a proxy works.** The `Origin` guard allows a request whose
  `Origin` matches the `Host` it arrived on, so the panel works on
  `*.up.railway.app`, Fly, Render, or a custom domain without configuration.
  Cross-origin requests are still refused with `403 model transport authentication
  required`. If you serve the panel from a *second* hostname, add it to
  `ALLOWED_ORIGINS`.
- **Login on a remote host needs one manual step.** DeepAI redirects the browser to
  `http://127.0.0.1:<port>/auth-callback`, which resolves to the *user's* machine, not
  the server. The tab will fail to load - copy that URL and paste it into **Manual
  sign-in** in the panel; the exchange then runs server-side and the account is
  stored. The panel shows a "remote host detected" notice when this applies.
- **`Auto-capture` needs local app data.** It scans `DEEPAI_USERDATA` for
  `secrets/deepai-account.bin`. In a container that directory is empty unless you
  mount `~/.deepai-code/userdata`; otherwise add accounts by pasting a key or JSON.
- **Persistence:** the compose mount is writable by default so panel changes
  (login, weights, rotation, remove) survive restarts. Add `:ro` to make it
  read-only; the server will still serve requests but writes will fail.
- **Network:** the container must reach `https://api.deepai.org`. No inbound
  access is required except the published proxy port.
- **Security:** credentials are plaintext (same as the desktop app). Keep the
  publish bound to loopback, set `PROXY_TOKEN` if other local processes should
  not spend your quota, and never commit `acc.json` / `accounts.json`.
- **Hardening:** the container runs as the non-root `node` user, with a read-only
  root filesystem, `/tmp` as tmpfs, `init: true`, and `no-new-privileges`.
  `/data` is chowned to that user so the credential store remains writable.
- **Healthcheck:** both the Dockerfile and compose hit `GET /health` locally;
  no credential is required for it.
