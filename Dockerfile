# syntax=docker/dockerfile:1
# Single instance only: the alarm's timers live in this one process (see CLAUDE.md, "Runtime model").

FROM node:26-bookworm-slim AS build
WORKDIR /app
# Node 25+ no longer bundles corepack; same pnpm version as package.json's packageManager.
RUN npm install -g pnpm@11.24.0
# Toolchain for argon2 and better-sqlite3, in case no prebuilt binary matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VERSION=dev
# Same steps as deploy/build.sh: the standalone server needs public/ and the static assets copied in.
RUN NEXT_TELEMETRY_DISABLED=1 pnpm build \
  && cp -r public .next/standalone/public \
  && cp -r .next/static .next/standalone/.next/static \
  && echo "$VERSION" > .next/standalone/VERSION

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/alarm.db \
    UAP_RUNTIME=docker
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
