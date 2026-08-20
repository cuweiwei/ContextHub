#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Install root-owned at /usr/local/libexec/contexthub-deploy. The companion
# forced-command wrapper validates SSH_ORIGINAL_COMMAND before invoking this
# file through a single sudoers allowlist entry.
CONFIG_FILE=/etc/contexthub/deploy.env
[[ -f "$CONFIG_FILE" ]] || { echo 'root dispatcher: deploy config is missing' >&2; exit 2; }
[[ "$(stat -c '%u' "$CONFIG_FILE" 2>/dev/null || echo -1)" == 0 ]] || { echo 'root dispatcher: deploy config must be root-owned' >&2; exit 2; }
[[ $(( $(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || echo 999) & 077 )) -eq 0 ]] || { echo 'root dispatcher: deploy config must not be group/world-readable' >&2; exit 2; }

config_value() {
  local name=$1 value
  value=$(awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$CONFIG_FILE")
  value=${value#\"}; value=${value%\"}
  printf '%s' "$value"
}

SOURCE_DIR=$(config_value SOURCE_DIR)
APP_DIR=$(config_value APP_DIR)
CONTAINER_NAME=$(config_value CONTAINER_NAME)
DEPLOY_SCRIPT=$(config_value DEPLOY_SCRIPT)
[[ "$SOURCE_DIR" = /* && "$APP_DIR" = /* ]] || { echo 'root dispatcher: paths must be absolute' >&2; exit 2; }
CONTAINER_NAME=${CONTAINER_NAME:-contexthub}
DEPLOY_SCRIPT=${DEPLOY_SCRIPT:-/usr/local/libexec/contexthub-deploy-engine}
[[ -x "$DEPLOY_SCRIPT" ]] || { echo 'root dispatcher: deployment engine is missing' >&2; exit 2; }
[[ "$(stat -c '%u' "$DEPLOY_SCRIPT" 2>/dev/null || echo -1)" == 0 ]] || { echo 'root dispatcher: deployment engine must be root-owned' >&2; exit 2; }

IMAGE=""; COMMIT=""; VERSION=""; WORKFLOW_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE=${2:?--image requires a value}; shift 2 ;;
    --expected-commit) COMMIT=${2:?--expected-commit requires a value}; shift 2 ;;
    --expected-version) VERSION=${2:?--expected-version requires a value}; shift 2 ;;
    --workflow-url) WORKFLOW_URL=${2:?--workflow-url requires a value}; shift 2 ;;
    *) echo "root dispatcher: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$IMAGE" =~ ^ghcr\.io/cuweiwei/contexthub@sha256:[0-9a-f]{64}$ ]] || { echo 'root dispatcher: invalid image' >&2; exit 2; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo 'root dispatcher: invalid commit' >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo 'root dispatcher: invalid version' >&2; exit 2; }
[[ "$WORKFLOW_URL" =~ ^https://github\.com/cuweiwei/ContextHub/actions/runs/[0-9]+$ ]] || { echo 'root dispatcher: invalid workflow URL' >&2; exit 2; }

exec bash "$DEPLOY_SCRIPT" \
  --source-dir "$SOURCE_DIR" --app-dir "$APP_DIR" --container "$CONTAINER_NAME" \
  --image "$IMAGE" --expected-commit "$COMMIT" --expected-version "$VERSION" \
  --workflow-url "$WORKFLOW_URL" --yes
