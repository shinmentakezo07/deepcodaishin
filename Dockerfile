# syntax=docker/dockerfile:1
FROM node:22-alpine

# deepai-proxy: OpenAI/Anthropic-compatible local gateway for DeepAI Code accounts.
# The Node runtime has zero npm dependencies; the React panel is prebuilt in ui/dist.
LABEL org.opencontainers.image.title="deepai-proxy" \
      org.opencontainers.image.description="Local proxy exposing DeepAI Code accounts via OpenAI/Anthropic-compatible endpoints" \
      org.opencontainers.image.source="https://github.com/shinmentakezo07/deepcodaishin"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ACC_PATH=/data/acc.json \
    ACCOUNTS_PATH=/data/accounts.json \
    DEEPAI_USERDATA=/data/userdata

WORKDIR /app

# Application source. Only runtime files are copied: the image has no build tools.
COPY deepai-proxy.mjs ./
COPY src ./src

# Prebuilt control panel (Vite/React/Tailwind output, including self-hosted fonts).
# No npm install or node_modules is needed at build or run time.
COPY ui/dist ./ui/dist

# Host file modes are not portable; normalise them for the non-root runtime user.
# /data is owned by that user so the panel can save/reorder accounts when the
# compose volume is mounted writable.
RUN chmod -R a+rX /app \
 && mkdir -p /data \
 && chown -R node:node /data /app

EXPOSE 8787

# Liveness: /health is served without auth and answers even with no credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node

ENTRYPOINT ["node", "deepai-proxy.mjs"]
CMD ["serve"]
