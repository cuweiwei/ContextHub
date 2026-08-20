#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Install this file root-owned at /usr/local/sbin/contexthub-deploy and use it
# as a forced command in a dedicated SSH key. It accepts no interactive shell.
original=${SSH_ORIGINAL_COMMAND:-}
read -r command image commit version workflow_url extra <<<"$original"
[[ "$command" == contexthub-deploy && -z "${extra:-}" ]] || { echo 'deploy wrapper: invalid command' >&2; exit 2; }
[[ "$image" =~ ^ghcr\.io/cuweiwei/contexthub@sha256:[0-9a-f]{64}$ ]] || { echo 'deploy wrapper: invalid image' >&2; exit 2; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'deploy wrapper: invalid commit' >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo 'deploy wrapper: invalid version' >&2; exit 2; }
[[ "$workflow_url" =~ ^https://github\.com/cuweiwei/ContextHub/actions/runs/[0-9]+$ ]] || { echo 'deploy wrapper: invalid workflow URL' >&2; exit 2; }

exec sudo -n /usr/local/libexec/contexthub-deploy \
  --image "$image" \
  --expected-commit "$commit" \
  --expected-version "$version" \
  --workflow-url "$workflow_url"
