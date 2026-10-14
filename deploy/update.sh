#!/usr/bin/env bash
# Update to a GitHub release tag and restart the service.
#
# Downloads the prebuilt standalone tarball release.yml attaches to each
# release (no pnpm or build toolchain needed on this box, that all happens
# in CI) and switches releases/current to point at it.
#
# Usage: ./deploy/update.sh [tag]     defaults to the most recently created tag
#   ./deploy/update.sh v1.0.0-rc.1
#
# Rollback: same command with an older tag — if its releases/<tag> dir is
# still on disk (see KEEP_RELEASES), this is just a symlink flip + restart,
# no re-download.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_RELEASES=5
TOKEN_FILE=/etc/unifi-alarm-panel-github-token

git fetch --tags --force --quiet
TAG="${1:-$(git tag --sort=-creatordate | head -1)}"
[ -n "$TAG" ] || { echo "No tags found — fetch failed or no releases published yet." >&2; exit 1; }

RELEASE_DIR="releases/$TAG"

if [ -d "$RELEASE_DIR" ]; then
  echo "$TAG already downloaded, reusing $RELEASE_DIR"
else
  # Public releases download anonymously. A token (Contents: Read-only) is only needed for a private fork.
  AUTH=()
  [ -f "$TOKEN_FILE" ] && AUTH=(-H "Authorization: token $(cat "$TOKEN_FILE")")
  REPO=$(git config --get remote.origin.url | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
  ASSET_NAME="unifi-alarm-panel-$TAG.tar.gz"

  echo "Resolving $ASSET_NAME from $REPO@$TAG"
  ASSET_URL=$(curl -sf ${AUTH[@]+"${AUTH[@]}"} -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" | jq -r ".assets[] | select(.name==\"$ASSET_NAME\") | .url")
  [ -n "$ASSET_URL" ] && [ "$ASSET_URL" != "null" ] || {
    echo "Asset $ASSET_NAME not found on release $TAG — did release.yml run for this tag?" >&2
    exit 1
  }

  TMP=$(mktemp)
  curl -sfL ${AUTH[@]+"${AUTH[@]}"} -H "Accept: application/octet-stream" "$ASSET_URL" -o "$TMP"
  mkdir -p "$RELEASE_DIR"
  tar xzf "$TMP" -C "$RELEASE_DIR"
  rm -f "$TMP"
fi

echo "Switching to $TAG"
ln -sfn "$RELEASE_DIR" current

# Prune old releases — keep the newest KEEP_RELEASES around for instant rollback.
ls -1dt releases/*/ 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))" | xargs -r rm -rf

sudo systemctl restart unifi-alarm-panel
sudo systemctl --no-pager status unifi-alarm-panel
