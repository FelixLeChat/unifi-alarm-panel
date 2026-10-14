#!/usr/bin/env bash
# Run as root, once a minute, by unifi-alarm-panel-updater.timer.
#
# The app (unprivileged, hardened, no sudo) can only ask for an update by
# writing a tag into $STATE_DIR/update-pending (see app/api/admin/update).
# This script is the only thing with permission to actually apply one:
# download + symlink swap + service restart, via the same deploy/update.sh
# used for a manual on-box update.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE_DIR="${UAP_STATE_DIR:-/var/lib/unifi-alarm-panel}"
MARKER="$STATE_DIR/update-pending"
STATUS="$STATE_DIR/update-status"

[ -f "$MARKER" ] || exit 0

TAG=$(cat "$MARKER")
rm -f "$MARKER"

# Defense in depth: the API route already validates this shape before
# writing the marker, but TAG ends up in mkdir/tar/symlink below, run as
# root — never trust a single check on a path that crosses a privilege
# boundary. Reject anything with "/", "..", or shell metacharacters.
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "failed:$TAG (rejected: unexpected tag shape)" > "$STATUS"
  chown uap:uap "$STATUS" 2>/dev/null || true
  exit 1
fi

echo "applying:$TAG" > "$STATUS"
if ./deploy/update.sh "$TAG" >>"$STATE_DIR/update.log" 2>&1; then
  echo "done:$TAG" > "$STATUS"
else
  echo "failed:$TAG" > "$STATUS"
fi

chown uap:uap "$STATUS" "$STATE_DIR/update.log" 2>/dev/null || true
