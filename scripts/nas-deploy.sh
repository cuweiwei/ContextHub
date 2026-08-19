#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  scripts/nas-deploy.sh --app-dir <production-dir> [options]

Options:
  --source-dir <git-dir>  Source repository (default: repository containing this script)
  --app-dir <dir>         Production directory containing .env, docker-compose.yml and data/
  --ref <git-ref>         Commit/ref to deploy (default: origin/main)
  --container <name>      Container name (default: contexthub)
  --preflight-only        Validate paths, private bind and target ref; do not use sudo or mutate production
  --no-fetch              Do not fetch origin/main before resolving --ref
  --yes                   Deploy after the upgrade gate without an interactive confirmation
  -h, --help              Show this help

The script never sources .env, never prints credentials and never restores a database automatically.
EOF
}

fail() {
  printf 'deploy error: %s\n' "$*" >&2
  exit 2
}

log() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$line"
  if [[ -n "${EVENT_LOG:-}" ]]; then
    printf '%s\n' "$line" >>"$EVENT_LOG"
  fi
}

SCRIPT_PATH=${BASH_SOURCE[0]:-}
if [[ -n "$SCRIPT_PATH" && -e "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)
  SOURCE_DIR=$(cd "$SCRIPT_DIR/.." && pwd -P)
else
  SOURCE_DIR=$(pwd -P)
fi
APP_DIR=""
REF="origin/main"
CONTAINER_NAME="contexthub"
PREFLIGHT_ONLY=0
FETCH=1
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir) SOURCE_DIR=${2:?--source-dir requires a value}; shift 2 ;;
    --app-dir) APP_DIR=${2:?--app-dir requires a value}; shift 2 ;;
    --ref) REF=${2:?--ref requires a value}; shift 2 ;;
    --container) CONTAINER_NAME=${2:?--container requires a value}; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --no-fetch) FETCH=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

[[ -n "$APP_DIR" ]] || { usage >&2; fail '--app-dir is required'; }
[[ "$SOURCE_DIR" = /* ]] || fail '--source-dir must be absolute'
[[ "$APP_DIR" = /* ]] || fail '--app-dir must be absolute'
SOURCE_DIR=$(cd "$SOURCE_DIR" && pwd -P)
APP_DIR=$(cd "$APP_DIR" && pwd -P)
[[ "$SOURCE_DIR" != "$APP_DIR" ]] || fail 'source and production app directories must be different'

command -v git >/dev/null || fail 'git is required'
command -v curl >/dev/null || fail 'curl is required'
command -v tar >/dev/null || fail 'tar is required'
[[ -d "$SOURCE_DIR/.git" ]] || fail "$SOURCE_DIR is not a Git worktree"
[[ -f "$APP_DIR/docker-compose.yml" ]] || fail "$APP_DIR/docker-compose.yml is missing"
[[ -f "$APP_DIR/.env" ]] || fail "$APP_DIR/.env is missing"
[[ -f "$APP_DIR/data/contexthub.db" ]] || fail "$APP_DIR/data/contexthub.db is missing"

env_value() {
  local name=$1
  local value
  value=$(awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/.env")
  value=${value#\"}
  value=${value%\"}
  printf '%s' "$value"
}

BIND_ADDRESS=$(env_value CONTEXTHUB_BIND_ADDRESS)
BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
[[ "$BIND_ADDRESS" == '127.0.0.1' ]] || fail 'CONTEXTHUB_BIND_ADDRESS must remain 127.0.0.1'
HOST_PORT=$(env_value CONTEXTHUB_HOST_PORT)
HOST_PORT=${HOST_PORT:-8788}
[[ "$HOST_PORT" =~ ^[0-9]+$ ]] || fail 'CONTEXTHUB_HOST_PORT must be numeric'
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"

if [[ "$FETCH" -eq 1 ]]; then
  log 'fetching origin/main'
  git -C "$SOURCE_DIR" fetch origin main
fi
COMMIT=$(git -C "$SOURCE_DIR" rev-parse "${REF}^{commit}")
SHORT_COMMIT=${COMMIT:0:12}
VERSION=$(git -C "$SOURCE_DIR" show "${COMMIT}:package.json" |
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
  head -1)
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || fail 'target package version is invalid'

log "source=$SOURCE_DIR"
log "production=$APP_DIR"
log "target=$COMMIT version=$VERSION"
log "private_health=$HEALTH_URL"
curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null || fail 'current production health check failed'

if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  log 'PREFLIGHT PASS'
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  [[ -t 0 ]] || fail '--yes is required for non-interactive deployment'
  read -r -p "Deploy $COMMIT ($VERSION) to $APP_DIR? [y/N] " answer
  [[ "$answer" == 'y' || "$answer" == 'Y' ]] || fail 'deployment cancelled'
fi

if [[ -x /var/packages/ContainerManager/target/usr/bin/docker ]]; then
  DOCKER_BIN=/var/packages/ContainerManager/target/usr/bin/docker
elif command -v docker >/dev/null; then
  DOCKER_BIN=$(command -v docker)
else
  fail 'Docker CLI is not available'
fi
if [[ -x /usr/local/bin/docker-compose ]]; then
  COMPOSE_BIN=/usr/local/bin/docker-compose
elif command -v docker-compose >/dev/null; then
  COMPOSE_BIN=$(command -v docker-compose)
else
  fail 'docker-compose CLI is not available'
fi

sudo -v
(
  while true; do
    sudo -n -v >/dev/null 2>&1 || exit 0
    sleep 30
  done
) &
SUDO_KEEPALIVE_PID=$!

STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
REPORT_DIR="$APP_DIR/deployments/${STAMP}-${SHORT_COMMIT}"
mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
EVENT_LOG="$REPORT_DIR/events.log"
BUILD_DIR=""
DEPLOY_ATTEMPTED=0
ROLLBACK_IMAGE=""

docker_admin() {
  sudo "$DOCKER_BIN" "$@"
}

compose_admin() {
  sudo "$COMPOSE_BIN" \
    --project-directory "$APP_DIR" \
    -f "$APP_DIR/docker-compose.yml" \
    "$@"
}

wait_for_health() {
  local output_file=$1
  local attempt
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >"$output_file"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_image() {
  [[ -n "$ROLLBACK_IMAGE" ]] || return 1
  log "rolling back to $ROLLBACK_IMAGE"
  docker_admin tag "$ROLLBACK_IMAGE" contexthub:latest
  compose_admin up -d --force-recreate --no-build
  if wait_for_health "$REPORT_DIR/health-after-rollback.json"; then
    log 'ROLLBACK HEALTHY'
    return 0
  fi
  log "ROLLBACK HEALTH FAILED; keep snapshot and follow docs/NAS-DEPLOY-RUNBOOK.md"
  return 1
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "${SUDO_KEEPALIVE_PID:-}" ]]; then
    kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$rc" -ne 0 ]]; then
    log "DEPLOYMENT FAILED rc=$rc"
    if [[ "$DEPLOY_ATTEMPTED" -eq 1 ]]; then
      rollback_image || true
    fi
  fi
  if [[ -n "$BUILD_DIR" ]]; then
    case "$BUILD_DIR" in
      /tmp/contexthub-build.*) rm -rf -- "$BUILD_DIR" ;;
      *) log "refusing to remove unexpected temp path: $BUILD_DIR" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

CURRENT_IMAGE_ID=$(docker_admin inspect --format '{{.Image}}' "$CONTAINER_NAME")
OLD_IMAGE_SHORT=${CURRENT_IMAGE_ID#sha256:}
OLD_IMAGE_SHORT=${OLD_IMAGE_SHORT:0:12}
ROLLBACK_IMAGE="contexthub:rollback-${STAMP}-${OLD_IMAGE_SHORT}"
CANDIDATE_IMAGE="contexthub:candidate-${SHORT_COMMIT}"
docker_admin tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"
log "rollback_image=$ROLLBACK_IMAGE"

BUILD_DIR=$(mktemp -d /tmp/contexthub-build.XXXXXX)
git -C "$SOURCE_DIR" archive --format=tar "$COMMIT" | tar -xf - -C "$BUILD_DIR"
[[ -x "$BUILD_DIR/scripts/upgrade-gate.sh" ]] || fail 'candidate upgrade gate is missing or not executable'

log "building $CANDIDATE_IMAGE from clean Git archive"
docker_admin build --pull \
  -t "$CANDIDATE_IMAGE" \
  --build-arg "CONTEXTHUB_BUILD_COMMIT=$COMMIT" \
  --build-arg "CONTEXTHUB_VERSION=$VERSION" \
  "$BUILD_DIR"

IMAGE_VERSION=$(docker_admin inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$CANDIDATE_IMAGE")
IMAGE_REVISION=$(docker_admin inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$CANDIDATE_IMAGE")
[[ "$IMAGE_VERSION" == "$VERSION" ]] || fail 'candidate OCI version label mismatch'
[[ "$IMAGE_REVISION" == "$COMMIT" ]] || fail 'candidate OCI revision label mismatch'

latest_manifest() {
  find "$APP_DIR/data/backups" -maxdepth 1 -type f -name 'contexthub-*.manifest.json' -print 2>/dev/null |
    sort |
    tail -1
}

BEFORE_MANIFEST=$(latest_manifest || true)
log 'requesting a verified backup from the running release'
if ! compose_admin exec -T "$CONTAINER_NAME" node dist/cli.js backup; then
  log 'running release does not support verified backup; using candidate no-migration backup'
fi
MANIFEST=$(latest_manifest || true)
if [[ -z "$MANIFEST" || "$MANIFEST" == "$BEFORE_MANIFEST" ]]; then
  docker_admin run --rm --read-only \
    --network none \
    -e DATA_DIR=/data \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    -v "$APP_DIR/data:/data" \
    "$CANDIDATE_IMAGE" node dist/cli.js backup
  MANIFEST=$(latest_manifest || true)
fi
[[ -n "$MANIFEST" && "$MANIFEST" != "$BEFORE_MANIFEST" && -f "$MANIFEST" ]] ||
  fail 'a new backup manifest was not produced'
log "backup_manifest=$(basename "$MANIFEST")"

GATE_PATH="$(dirname "$DOCKER_BIN"):/usr/local/bin:/usr/bin:/bin"
log 'running read-only upgrade gate'
sudo env PATH="$GATE_PATH" DATA_DIR="$APP_DIR/data" bash \
  "$BUILD_DIR/scripts/upgrade-gate.sh" \
  --image "$CANDIDATE_IMAGE" \
  --snapshot "$MANIFEST"

log 'upgrade gate passed; starting candidate'
docker_admin tag "$CANDIDATE_IMAGE" contexthub:latest
DEPLOY_ATTEMPTED=1
compose_admin up -d --force-recreate --no-build

wait_for_health "$REPORT_DIR/health-after-start.json" || fail 'candidate health check timed out'
grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$VERSION"'"' "$REPORT_DIR/health-after-start.json" ||
  fail 'health version does not match candidate'
grep -Eq '"build_commit"[[:space:]]*:[[:space:]]*"'"$COMMIT"'"' "$REPORT_DIR/health-after-start.json" ||
  fail 'health build commit does not match candidate'

log 'rebuilding retrieval projections'
compose_admin exec -T "$CONTAINER_NAME" node dist/cli.js reindex
compose_admin exec -T "$CONTAINER_NAME" node dist/cli.js retrieval-status >"$REPORT_DIR/retrieval-status.json"

MANIFEST_NAME=$(basename "$MANIFEST")
log 'recording an isolated restore drill'
compose_admin exec -T "$CONTAINER_NAME" \
  node dist/cli.js restore-drill --snapshot "/data/backups/$MANIFEST_NAME" --json |
  tee "$REPORT_DIR/restore-drill.json"

log 'running scheduled idempotency GC before doctor'
compose_admin exec -T "$CONTAINER_NAME" node dist/cli.js idempotency-gc --days 90 |
  tee "$REPORT_DIR/idempotency-gc.txt"

log 'running production doctor'
compose_admin exec -T "$CONTAINER_NAME" node dist/cli.js doctor --json |
  tee "$REPORT_DIR/doctor.json"

wait_for_health "$REPORT_DIR/health-final.json" || fail 'final health check failed'
RUNNING_IMAGE_ID=$(docker_admin inspect --format '{{.Image}}' "$CONTAINER_NAME")
CANDIDATE_IMAGE_ID=$(docker_admin image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")
[[ "$RUNNING_IMAGE_ID" == "$CANDIDATE_IMAGE_ID" ]] || fail 'running container is not using the candidate image'

printf '{\n  "status": "verified",\n  "version": "%s",\n  "commit": "%s",\n  "completed_at": "%s",\n  "backup_manifest": "%s",\n  "rollback_image": "%s"\n}\n' \
  "$VERSION" "$COMMIT" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$MANIFEST_NAME" "$ROLLBACK_IMAGE" \
  >"$REPORT_DIR/release.json"

DEPLOY_ATTEMPTED=0
log "DEPLOYMENT VERIFIED commit=$COMMIT version=$VERSION"
