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

- **Login inside the container works.** The UI flow points the `port` parameter
  at the panel's own port and `GET /auth-callback` is handled by the main server.
  Publishing `127.0.0.1:8787` is enough - no ephemeral callback port is needed.
  If a browser tab still ends on a callback URL, paste it into **Manual sign-in**.
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
