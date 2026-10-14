#!/usr/bin/env bash
# Downloads the latest go2rtc release binary (public repo, no token needed)
# to /usr/local/bin/go2rtc. Re-run to upgrade — safe to run while the
# unifi-alarm-panel-go2rtc service is active, restart it afterwards to
# pick up the new binary.
#
# Usage: ./deploy/install-go2rtc.sh
set -euo pipefail

# The MJPEG output this app actually uses needs a transcode producer
# (ffmpeg:{name}#video=mjpeg — see lib/services/go2rtc-client.ts), which
# go2rtc runs by shelling out to a real `ffmpeg` binary on $PATH. Its RTSP
# client itself doesn't need ffmpeg (that part IS a codec-copy passthrough),
# but this app's MJPEG proxy does — missing this fails silently at the
# *streaming* request, not at registration, which makes it confusing to spot.
command -v ffmpeg >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y ffmpeg; }

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ASSET=go2rtc_linux_amd64 ;;
  aarch64) ASSET=go2rtc_linux_arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET_URL=$(curl -sf "https://api.github.com/repos/AlexxIT/go2rtc/releases/latest" | jq -r ".assets[] | select(.name==\"$ASSET\") | .browser_download_url")
[ -n "$ASSET_URL" ] && [ "$ASSET_URL" != "null" ] || {
  echo "Couldn't resolve the $ASSET asset from go2rtc's latest release." >&2
  exit 1
}

echo "Downloading $ASSET_URL"
TMP=$(mktemp)
curl -sfL "$ASSET_URL" -o "$TMP"
sudo install -m 755 -o root -g root "$TMP" /usr/local/bin/go2rtc
rm -f "$TMP"

/usr/local/bin/go2rtc -version
echo "Installed. Next: sudo cp deploy/go2rtc.yaml /etc/go2rtc.yaml && sudo cp deploy/unifi-alarm-panel-go2rtc.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now unifi-alarm-panel-go2rtc"
