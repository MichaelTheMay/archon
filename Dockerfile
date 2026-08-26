# ── build ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN corepack enable && apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/agents/package.json packages/agents/
COPY packages/server/package.json packages/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build && pnpm --filter @archon/server --prod deploy /out
# deploy prunes dev deps but drops the built web assets; carry them over explicitly.
RUN cp -r apps/web/dist /out/web-dist

# ── run ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST=../web-dist PORT=8787
RUN mkdir -p /data
COPY --from=build /out ./
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
