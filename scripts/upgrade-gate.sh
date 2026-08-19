#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=""
MANIFEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2;;
    --snapshot) MANIFEST="$2"; shift 2;;
    *) echo "usage: $0 --image <candidate-image> [--snapshot <manifest.json>]" >&2; exit 2;;
  esac
done
[[ -n "$IMAGE" ]] || { echo "--image is required" >&2; exit 2; }
if [[ -z "$MANIFEST" ]]; then
  npm run cli -- backup >/dev/null
  MANIFEST=$(find "${DATA_DIR:-./data}/backups" -type f -name '*.manifest.json' -print | sort | tail -1)
fi
[[ -f "$MANIFEST" ]] || { echo "verified backup manifest is required" >&2; exit 2; }

SNAP_DIR=$(cd "$(dirname "$MANIFEST")" && pwd)
SNAP_NAME=$(basename "$MANIFEST")
docker run --rm \
  --read-only \
  -e DATA_DIR=/gate-data \
  --tmpfs /gate-data:rw,noexec,nosuid,size=256m \
  -v "$SNAP_DIR:/gate-snapshot:ro" \
  "$IMAGE" node dist/cli.js restore-drill --snapshot "/gate-snapshot/$SNAP_NAME" --json
echo "upgrade gate passed; candidate was not started"
