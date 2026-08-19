#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tracked=$(git ls-files -z)
if [[ -z "$tracked" ]]; then exit 0; fi

bad_paths=$(printf '%s' "$tracked" | tr '\0' '\n' | grep -Ei '(^|/)(\.env($|\.)|.*\.(db|db-wal|db-shm|sqlite|sqlite3)|dist/|build/)' || true)
if [[ -n "$bad_paths" ]]; then
  echo "tracked secret/database/build paths are not allowed:" >&2
  echo "$bad_paths" >&2
  exit 1
fi

if git grep -nI -E -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|chk_[A-Za-z0-9_-]{40,}|enr_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{32,}' -- ':!scripts/check-repo-hygiene.sh'; then
  echo "tracked credential or private-key pattern found" >&2
  exit 1
fi

echo "repo hygiene: clean"
