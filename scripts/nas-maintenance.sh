#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() { cat <<'EOF'
Usage: scripts/nas-maintenance.sh --app-dir <production-dir> --task daily|weekly|monthly

Runs one metadata-only NAS maintenance task through the existing container:
daily backup + doctor; weekly idempotency GC; monthly restore drill + audit anchor.
The owner installs this script in Synology Task Scheduler after a read-only review.
EOF
}
APP_DIR=""; TASK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR=${2:?--app-dir requires a value}; shift 2 ;;
    --task) TASK=${2:?--task requires a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$APP_DIR" = /* && -d "$APP_DIR" ]] || { echo 'app directory must be an existing absolute path' >&2; exit 2; }
[[ "$TASK" == daily || "$TASK" == weekly || "$TASK" == monthly ]] || { echo 'task must be daily, weekly or monthly' >&2; exit 2; }
[[ -f "$APP_DIR/docker-compose.yml" && -f "$APP_DIR/.env" ]] || { echo 'compose or .env is missing' >&2; exit 2; }
if command -v docker-compose >/dev/null; then COMPOSE=$(command -v docker-compose)
elif command -v docker >/dev/null; then COMPOSE=$(command -v docker); COMPOSE_SUBCOMMAND=1
else echo 'Docker Compose is not available' >&2; exit 2; fi
compose() {
  if [[ "${COMPOSE_SUBCOMMAND:-0}" -eq 1 ]]; then
    "$COMPOSE" compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"
  else
    "$COMPOSE" --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" "$@"
  fi
}
CONTAINER_NAME=$(awk -F= '$1 == "CONTAINER_NAME" { print $2; exit }' "$APP_DIR/.env" | tr -d '"' | tr -d "'" || true)
CONTAINER_NAME=${CONTAINER_NAME:-contexthub}
stamp=$(date -u '+%Y%m%dT%H%M%SZ')
case "$TASK" in
  daily)
    compose exec -T "$CONTAINER_NAME" node dist/cli.js backup
    compose exec -T "$CONTAINER_NAME" node dist/cli.js doctor --json
    ;;
  weekly)
    compose exec -T "$CONTAINER_NAME" node dist/cli.js idempotency-gc --days 90
    ;;
  monthly)
    manifest=$(find "$APP_DIR/data/backups" -maxdepth 1 -type f -name 'contexthub-*.manifest.json' -print 2>/dev/null | sort | tail -1)
    [[ -n "$manifest" ]] || { echo 'no backup manifest available for restore drill' >&2; exit 2; }
    compose exec -T "$CONTAINER_NAME" node dist/cli.js restore-drill --snapshot "/data/backups/$(basename "$manifest")" --json
    compose exec -T "$CONTAINER_NAME" node dist/cli.js audit-anchor --out "/audit-anchors/audit-anchor-$stamp.json" --backup-id "$(basename "$manifest" .manifest.json)"
    ;;
esac
printf '%s\n' "maintenance task=$TASK completed_at=$stamp"
