#!/usr/bin/env bash
# Runs inside the new container (as root) and sets up UniFi Alarm Panel. Started by
# deploy/proxmox/install.sh, but it also works on a fresh Debian 12 or 13 box or LXC:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/FelixLeChat/unifi-alarm-panel/main/deploy/proxmox/container-setup.sh)"
#
# It reuses the bare-box deploy scripts: bootstrap.sh, update.sh, install-go2rtc.sh and the
# systemd units. Environment: UAP_VERSION (a release tag, default the latest),
# WITH_GO2RTC (yes|no, default yes), NODE_MAJOR (default 26, which is what CI builds against).
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO=FelixLeChat/unifi-alarm-panel
APP=/opt/unifi-alarm-panel
ENV_FILE=/etc/unifi-alarm-panel.env
NODE_MAJOR=${NODE_MAJOR:-26}
WITH_GO2RTC=${WITH_GO2RTC:-yes}

info() { printf '  - %s\n' "$*"; }

info "Installing packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq openssl sudo >/dev/null

# The release tarball carries native modules built for Node $NODE_MAJOR, so the container needs
# the same major. NodeSource's signed apt repo, as documented by NodeSource.
info "Installing Node.js $NODE_MAJOR from NodeSource"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs >/dev/null

TAG=${UAP_VERSION:-}
[ -n "$TAG" ] || TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | jq -r .tag_name)
[ -n "$TAG" ] && [ "$TAG" != null ] || { echo "Couldn't find a release to install." >&2; exit 1; }
info "Installing $TAG"

if [ ! -d "$APP/.git" ]; then git clone --quiet "https://github.com/$REPO.git" "$APP"; fi
git config --global --add safe.directory "$APP"
cd "$APP"
./deploy/bootstrap.sh >/dev/null

if [ ! -f "$ENV_FILE" ]; then
  info "Generating secrets in $ENV_FILE"
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
NEXT_TELEMETRY_DISABLED=1
DATABASE_PATH=/var/lib/unifi-alarm-panel/alarm.db
ADMIN_TOKEN=$(openssl rand -hex 24)
WEBHOOK_SHARED_SECRET=$(openssl rand -hex 24)
SECRETS_KEY=$(openssl rand -base64 32)
UPDATE_CHECK_REPO=$REPO
EOF
  chown uap:uap "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

install -m 644 deploy/unifi-alarm-panel.service /etc/systemd/system/
install -m 644 deploy/unifi-alarm-panel-updater.service deploy/unifi-alarm-panel-updater.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q unifi-alarm-panel unifi-alarm-panel-updater.timer
systemctl start unifi-alarm-panel-updater.timer

info "Downloading and starting the release"
./deploy/update.sh "$TAG" >/dev/null

if [ "$WITH_GO2RTC" = yes ]; then
  info "Installing go2rtc and ffmpeg"
  # install-go2rtc.sh runs apt through sudo, which drops DEBIAN_FRONTEND, so ffmpeg goes in first.
  apt-get install -y -qq ffmpeg >/dev/null
  ./deploy/install-go2rtc.sh >/dev/null
  install -m 644 deploy/go2rtc.yaml /etc/go2rtc.yaml
  install -m 644 deploy/unifi-alarm-panel-go2rtc.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable -q --now unifi-alarm-panel-go2rtc
fi

cat >/usr/local/bin/update-unifi-alarm-panel <<'EOF'
#!/bin/sh
# Update to the latest release, or to the tag you pass.
set -e
cd /opt/unifi-alarm-panel
git pull --quiet --ff-only
exec ./deploy/update.sh "$@"
EOF
chmod 755 /usr/local/bin/update-unifi-alarm-panel

info "Waiting for the app"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:3000/api/health >/dev/null || { echo "The app didn't come up. See: journalctl -u unifi-alarm-panel" >&2; exit 1; }

# shellcheck disable=SC1090
set -a && . "$ENV_FILE" && set +a
cat <<EOF

UniFi Alarm Panel $TAG is running.

  ADMIN_TOKEN           $ADMIN_TOKEN
  WEBHOOK_SHARED_SECRET $WEBHOOK_SHARED_SECRET
  SECRETS_KEY           $SECRETS_KEY

Save these now. They are also in $ENV_FILE inside the container.
Keep a copy of SECRETS_KEY somewhere safe: without it, stored credentials have to be re-entered.
Open /admin, sign in with ADMIN_TOKEN and finish the setup wizard.
EOF
