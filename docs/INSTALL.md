# Install

Pick one. All of them run the same single Node process with one SQLite file: never run two copies, the alarm's timers live in that process.

## Docker Compose

```bash
git clone https://github.com/FelixLeChat/unifi-alarm-panel.git
cd unifi-alarm-panel
cat > .env <<EOF
ADMIN_TOKEN=$(openssl rand -hex 24)
WEBHOOK_SHARED_SECRET=$(openssl rand -hex 24)
SECRETS_KEY=$(openssl rand -base64 32)
EOF
docker compose up -d
```

Open `http://<this-host>:3000/admin`, sign in with `ADMIN_TOKEN`, and the setup wizard walks you through the console connection, notifications and the kiosk. Then point the tablet at `http://<this-host>:3000/panel`.

`docker-compose.yml` runs the app and go2rtc (live camera view). Data lives in the `data` volume. Run one app container only: the alarm's timers live in that process.

**Update:** `docker compose pull && docker compose up -d`. The admin Tasks screen shows when a release is out.

## Proxmox VE (one command)

On a Proxmox VE host, run this in the host shell as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/FelixLeChat/unifi-alarm-panel/main/deploy/proxmox/install.sh)"
```

Read [the script](../deploy/proxmox/install.sh) first if you like: it is short, and it fetches [one more](../deploy/proxmox/container-setup.sh) that runs inside the new container. Pin both to a ref with `UAP_REF=<tag or commit>`.

It asks for Default or Advanced, then:

1. Creates an unprivileged Debian 13 (or 12) container with nesting on. Defaults: 1 core, 1 GB RAM, 4 GB disk (6 GB with go2rtc), DHCP on `vmbr0`, started on boot.
2. Installs Node.js 26 from NodeSource's signed apt repo, clones this repo to `/opt/unifi-alarm-panel` and runs the same `deploy/bootstrap.sh` and `deploy/update.sh` as the systemd install.
3. Writes `/etc/unifi-alarm-panel.env` with fresh `ADMIN_TOKEN`, `WEBHOOK_SHARED_SECRET` and `SECRETS_KEY`, installs the service and the auto-update timer, and optionally go2rtc with ffmpeg for the live camera view.
4. Prints the three secrets once and the URL. **Keep a copy of `SECRETS_KEY`.**

Then finish the setup wizard at `http://<container-ip>:3000/admin`.

Skip the prompts with `UAP_YES=1` and variables such as `CT_RAM=2048`, `CT_IP=192.168.1.50/24 CT_GATEWAY=192.168.1.1` or `WITH_GO2RTC=no`. The full list is in the header of `install.sh`.

**Update:** `pct exec <CTID> -- update-unifi-alarm-panel`, or the "Update available" banner in the admin UI. **Remove:** `pct stop <CTID> && pct destroy <CTID>`.

**Needs:** amd64, internet during the install (GitHub, `deb.nodesource.com`, the Debian mirrors, and GitHub again for go2rtc), and a storage that can hold container volumes. If the service fails with `Failed to set up mount namespacing`, turn on Nesting in the container's Options > Features.

## Without Docker (systemd)

Runs directly on a Linux box, LXC container or VM under systemd. Releases ship prebuilt: `.github/workflows/release.yml` attaches a standalone tarball to every `v*` tag's GitHub Release (and pushes the Docker image). The box downloads it, so there is no pnpm and no native-module compile on the box.

**Requirements:** Node.js 22 LTS or newer (tested on 26.x) and `jq` (`deploy/bootstrap.sh` installs it).

```bash
# On the box, as a normal user with sudo:
git clone https://github.com/FelixLeChat/unifi-alarm-panel.git /opt/unifi-alarm-panel
cd /opt/unifi-alarm-panel

./deploy/bootstrap.sh   # one-time, idempotent: "uap" system user, dirs, jq

cp .env.example /etc/unifi-alarm-panel.env
$EDITOR /etc/unifi-alarm-panel.env   # ADMIN_TOKEN, WEBHOOK_SHARED_SECRET, SECRETS_KEY
sudo chmod 600 /etc/unifi-alarm-panel.env

./deploy/update.sh v1.0.0   # omit the tag for the latest release

sudo cp deploy/unifi-alarm-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unifi-alarm-panel
sudo journalctl -u unifi-alarm-panel -f

# Optional but recommended: lets the admin UI's "Update available" banner apply the update
sudo cp deploy/unifi-alarm-panel-updater.service deploy/unifi-alarm-panel-updater.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unifi-alarm-panel-updater.timer
```

Then finish the setup wizard at `http://<this-box>:3000/admin`.

A GitHub token is only needed to download releases from a private fork: put a fine-grained PAT with "Contents: Read-only" in `/etc/unifi-alarm-panel-github-token` (chmod 600, owned by `uap`).

**Update:** `./deploy/update.sh [tag]`. It downloads the tarball into `releases/<tag>/`, flips the `current` symlink and restarts. Roll back the same way with an older tag. The last 5 releases stay on disk, so a rollback is a symlink flip and a restart.

**Auto-update from the admin UI:** the app checks GitHub hourly (`lib/services/update-check.ts`) and shows an "Update available" banner. Clicking it only drops the target tag into the state dir, because `unifi-alarm-panel.service` runs unprivileged on purpose (no sudo, `ProtectSystem=strict`). `unifi-alarm-panel-updater.timer` (root, every minute) runs the real `update.sh` and restarts. Without the timer, the banner still tells you a release is out and you run `update.sh` yourself. In Docker the banner is hidden and Tasks says to pull the new image.

**Live camera view:** go2rtc runs next to the app. With systemd, see `deploy/install-go2rtc.sh`, `deploy/go2rtc.yaml` and `deploy/unifi-alarm-panel-go2rtc.service`.

## First run

The setup wizard walks through the encryption key, the console connection (with a test that says why it failed), notifications and the kiosk. Every step can be skipped.


## Point UniFi at the app

Point UniFi Alarm Manager's webhook at `http://<this-box>:3000/api/hooks/sensor` with the shared secret in an `X-Alarm-Secret` header, once you've tripped a sensor and confirmed the payload shape. Prefer the header. The `?token=<WEBHOOK_SHARED_SECRET>` form still works for consoles that can't set one, but a secret in a URL lands in the access log of any proxy added later.

The Alarm Manager webhook payload shape may need the config-mapped fields in `lib/services/webhook-intake.ts` (`webhookSensorIdPath`, `webhookEventTypePath`) tuned.
