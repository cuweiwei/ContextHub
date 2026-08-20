#!/usr/bin/env bash
set -Eeuo pipefail

# Owner-run bootstrap helper. It deliberately requires an explicit target and
# never edits sudoers or authorized_keys automatically.
TARGET_DIR=${1:?usage: install-nas-deploy-wrapper.sh <root-owned-wrapper-dir>}
[[ "$TARGET_DIR" = /* ]] || { echo 'target must be absolute' >&2; exit 2; }
install -d -m 0755 "$TARGET_DIR"
install -o root -g root -m 0755 "$(dirname "$0")/nas-deploy-wrapper.sh" "$TARGET_DIR/contexthub-deploy-wrapper.sh"
install -o root -g root -m 0755 "$(dirname "$0")/nas-deploy-root-dispatch.sh" "$TARGET_DIR/contexthub-deploy"
install -o root -g root -m 0755 "$(dirname "$0")/nas-deploy.sh" "$TARGET_DIR/contexthub-deploy-engine"
install -o root -g root -m 0755 "$(dirname "$0")/upgrade-gate.sh" "$TARGET_DIR/upgrade-gate.sh"
echo "wrapper installed at $TARGET_DIR/contexthub-deploy-wrapper.sh"
echo "dispatcher installed at $TARGET_DIR/contexthub-deploy"
echo "deployment engine and gate installed at $TARGET_DIR"
echo 'Next: place the dispatcher at /usr/local/libexec/contexthub-deploy, create root-only /etc/contexthub/deploy.env, and add a sudoers rule allowing only that exact path.'
