#!/usr/bin/env bash
# One-time host setup: system user + state dir, and chown of the repo you've already
# cloned to /opt/unifi-alarm-panel. Idempotent — safe to re-run (e.g. after wiping
# and re-testing on a fresh LXC/VM). Run from inside the clone: ./deploy/bootstrap.sh
set -euo pipefail

id -u uap &>/dev/null || sudo useradd --system --home /opt/unifi-alarm-panel --shell /usr/sbin/nologin uap

sudo mkdir -p /var/lib/unifi-alarm-panel
sudo chown -R uap:uap /opt/unifi-alarm-panel /var/lib/unifi-alarm-panel

# update.sh parses release-asset JSON from the GitHub API — no build toolchain
# needed on this box any more, releases ship prebuilt (see deploy/update.sh).
command -v jq >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y jq; }

echo "Host ready. Next:"
echo "  cp .env.example /etc/unifi-alarm-panel.env && sudo chmod 600 /etc/unifi-alarm-panel.env"
echo "  \$EDITOR /etc/unifi-alarm-panel.env"
echo "  (private fork only) echo '<a fine-grained PAT, Contents: Read-only>' | sudo tee /etc/unifi-alarm-panel-github-token >/dev/null && sudo chown uap:uap /etc/unifi-alarm-panel-github-token && sudo chmod 600 /etc/unifi-alarm-panel-github-token"
echo "  ./deploy/update.sh"
echo "  (optional, for live camera streaming in the admin Sensors screen) ./deploy/install-go2rtc.sh"
