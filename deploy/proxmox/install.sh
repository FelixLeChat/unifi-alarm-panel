#!/usr/bin/env bash
# Creates an LXC container on a Proxmox VE host and installs UniFi Alarm Panel in it.
#
# Run on the Proxmox host, as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/FelixLeChat/unifi-alarm-panel/main/deploy/proxmox/install.sh)"
#
# It asks Default or Advanced, creates an unprivileged Debian container, then runs
# deploy/proxmox/container-setup.sh inside it. That script installs Node, the latest
# release and the systemd units with the same deploy/*.sh scripts a bare-box install uses.
#
# Skip the prompts with environment variables, for example:
#   UAP_YES=1 CT_RAM=2048 WITH_GO2RTC=no bash install.sh
# CTID CT_HOSTNAME CT_CORES CT_RAM CT_DISK CT_STORAGE CT_TEMPLATE_STORAGE CT_BRIDGE CT_VLAN
# CT_IP (dhcp or a CIDR such as 192.168.1.50/24) CT_GATEWAY WITH_GO2RTC (yes|no)
# UAP_VERSION (a release tag, default the latest) UAP_REF (git ref of these scripts, default main)
set -Eeuo pipefail

REPO=FelixLeChat/unifi-alarm-panel
UAP_REF=${UAP_REF:-main}
RAW="https://raw.githubusercontent.com/$REPO/$UAP_REF"

info() { printf '\033[33m[..]\033[0m %s\n' "$*"; }
ok() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO (exit $?). The container, if it was created, is left in place for you to inspect or remove with: pct destroy ${CTID:-<id>}"' ERR

[ "$(id -u)" -eq 0 ] || die "Run this as root on the Proxmox host."
{ command -v pct && command -v pveam; } >/dev/null || die "This must run on a Proxmox VE host (pct and pveam not found)."
[ "$(dpkg --print-architecture)" = amd64 ] || die "Releases are built for amd64 only."

ask() { # ask VAR "prompt" default
  local var=$1 prompt=$2 default=$3 reply
  if [ -n "${!var:-}" ] || [ "${MODE:-default}" = default ]; then
    printf -v "$var" '%s' "${!var:-$default}"
    return
  fi
  read -r -p "$prompt [$default]: " reply || true
  printf -v "$var" '%s' "${reply:-$default}"
}

MODE=default
if [ -z "${UAP_YES:-}" ] && [ -t 0 ]; then
  read -r -p "Install mode, (d)efault or (a)dvanced? [d]: " reply || true
  case "${reply:-d}" in a | A | advanced) MODE=advanced ;; esac
fi

first_storage() { pvesm status -content "$1" | awk 'NR>1 && $3=="active" {print $1; exit}'; }

ask CTID "Container ID" "$(pvesh get /cluster/nextid)"
ask CT_HOSTNAME "Hostname" "unifi-alarm-panel"
ask CT_CORES "CPU cores" "1"
ask CT_RAM "Memory (MB)" "1024"
ask WITH_GO2RTC "Install go2rtc for the live camera view (adds ffmpeg, about 300 MB)? (yes|no)" "yes"
ask CT_DISK "Disk (GB)" "$([ "$WITH_GO2RTC" = yes ] && echo 6 || echo 4)"
ask CT_STORAGE "Container storage" "$(first_storage rootdir)"
ask CT_TEMPLATE_STORAGE "Template storage" "$(first_storage vztmpl)"
ask CT_BRIDGE "Network bridge" "vmbr0"
ask CT_VLAN "VLAN tag (empty for none)" ""
ask CT_IP "IPv4 address (dhcp or a CIDR)" "dhcp"
if [ "$CT_IP" != dhcp ]; then ask CT_GATEWAY "Gateway" ""; fi
[ -n "$CT_STORAGE" ] && [ -n "$CT_TEMPLATE_STORAGE" ] || die "No storage found for containers or templates."
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."

info "Finding a Debian template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '$2 ~ /^debian-(13|12)-standard/ {print $2}' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || die "No Debian 12 or 13 template is available."
pveam list "$CT_TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$CT_TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
ok "Template $TEMPLATE"

NET="name=eth0,bridge=$CT_BRIDGE,ip=$CT_IP"
[ "$CT_IP" != dhcp ] && [ -n "${CT_GATEWAY:-}" ] && NET+=",gw=$CT_GATEWAY"
[ -n "$CT_VLAN" ] && NET+=",tag=$CT_VLAN"

info "Creating container $CTID"
pct create "$CTID" "$CT_TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" --cores "$CT_CORES" --memory "$CT_RAM" \
  --rootfs "$CT_STORAGE:$CT_DISK" --net0 "$NET" \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --tags "alarm;unifi" >/dev/null
pct start "$CTID"
ok "Container $CTID started"

info "Waiting for the network"
for _ in $(seq 1 60); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "The container has no network or DNS. Check the bridge, VLAN and IP settings."

info "Installing UniFi Alarm Panel (a few minutes)"
SETUP=$(curl -fsSL "$RAW/deploy/proxmox/container-setup.sh")
pct exec "$CTID" -- env "UAP_VERSION=${UAP_VERSION:-}" "WITH_GO2RTC=$WITH_GO2RTC" bash -c "$SETUP"

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
ok "Done. Admin: http://$IP:3000/admin  Panel: http://$IP:3000/panel"
echo "Update later with: pct exec $CTID -- update-unifi-alarm-panel"
