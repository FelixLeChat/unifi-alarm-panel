#!/usr/bin/env bash
# Runs once when the dev container is created: pnpm, dependencies and a .env with fresh secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

# The volumes mounted over node_modules and .next start out owned by root.
sudo chown "$(id -u):$(id -g)" node_modules .next

# better-sqlite3 and argon2 compile from source when no prebuilt binary matches (Node 26 on arm64,
# for one), same as the toolchain in the Dockerfile. The base image's python3 is the minimal one.
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends python3 make g++ >/dev/null

# Same pnpm as package.json's packageManager. Node 25+ no longer bundles corepack.
npm install -g "$(node -p "require('./package.json').packageManager")" >/dev/null
# Keep the pnpm store out of the bind-mounted checkout.
pnpm config set store-dir "$HOME/.pnpm-store"
pnpm install --frozen-lockfile

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -hex 24)|" .env
  sed -i "s|^WEBHOOK_SHARED_SECRET=.*|WEBHOOK_SHARED_SECRET=$(openssl rand -hex 24)|" .env
  sed -i "s|^SECRETS_KEY=.*|SECRETS_KEY=$(openssl rand -base64 32)|" .env
  sed -i "s|^DATABASE_PATH=.*|DATABASE_PATH=./data/dev.db|" .env
fi

cat <<'EOF'

Ready. Try:
  pnpm dev            # http://localhost:3000/admin, token "dev"
  pnpm protect:mock   # a fake UniFi Protect on :8089, then set the console URL to http://localhost:8089
  pnpm test           # unit tests
  pnpm exec playwright install --with-deps chromium && pnpm test:e2e   # once, then e2e
EOF
