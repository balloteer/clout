# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CLOUT_TRUST_PROXY_HOPS=0

WORKDIR /app

# Install only the API and its shared market workspace. Keeping tsx as an API
# runtime dependency lets Node load the checked TypeScript sources without
# shipping the Expo application or test toolchain in this image.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/markets/package.json packages/markets/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev \
      --workspace @clout/api \
      --workspace @clout/markets \
      --workspace @clout/shared \
      --include-workspace-root=false \
      --ignore-scripts \
    && npm cache clean --force

COPY apps/api/src apps/api/src
COPY apps/mobile/assets/media apps/mobile/assets/media
COPY apps/mobile/src/lib/curated-content.json apps/mobile/src/lib/curated-content.json
COPY packages/markets/src packages/markets/src
COPY packages/shared/src packages/shared/src
COPY scripts/db-tls.mjs scripts/db-tls.mjs
COPY supabase/certs/prod-ca-2021.crt supabase/certs/prod-ca-2021.crt

WORKDIR /app/apps/api
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
