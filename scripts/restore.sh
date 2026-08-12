#!/usr/bin/env bash
# Restore ContextHub from a VACUUM INTO snapshot (NAS runbook, also the
# monthly restore-drill script). Usage:
#
#   ./scripts/restore.sh /volume1/docker/contexthub/data/backups/contexthub-<ts>.db
#
# What it does — and WHY each step exists:
#   1. stop the container            (single-writer promise: never two writers)
#   2. move the live db + -wal/-shm aside   (WAL sidecars from the OLD db must
#      never be replayed into the restored file)
#   3. copy the snapshot into place
#   4. start the container
#   5. REINDEX — MANDATORY: FTS rowids and local vectors are rebuildable
#      projections and are never trusted across a restore/model change.
#   6. health check + a smoke query
set -euo pipefail
cd "$(dirname "$0")/.."

SNAPSHOT="${1:?usage: restore.sh <snapshot.db>}"
DATA_DIR="${DATA_DIR:-./data}"
DB="$DATA_DIR/contexthub.db"
STAMP=$(date +%Y%m%d-%H%M%S)

[[ -f "$SNAPSHOT" ]] || { echo "snapshot not found: $SNAPSHOT"; exit 1; }

container_health() {
  docker compose exec -T contexthub node -e \
    "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

echo "== stopping contexthub =="
docker compose stop contexthub

echo "== setting the old database aside (kept as $DB.pre-restore-$STAMP) =="
[[ -f "$DB" ]] && mv "$DB" "$DB.pre-restore-$STAMP"
rm -f "$DB-wal" "$DB-shm"   # stale WAL/SHM must not be replayed into the restored db

echo "== restoring snapshot =="
cp "$SNAPSHOT" "$DB"

echo "== starting contexthub =="
docker compose up -d contexthub
for i in $(seq 1 60); do
  sleep 1
  if container_health; then break; fi
  [[ $i == 60 ]] && { echo "server did not come up after restore"; exit 1; }
done

echo "== rebuilding FTS + vector retrieval projections (mandatory after restore) =="
docker compose exec contexthub node dist/cli.js reindex
docker compose exec contexthub node dist/cli.js retrieval-status

echo "== verification =="
docker compose exec -T contexthub node -e \
  "fetch('http://127.0.0.1:8787/health').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
echo ""
docker compose exec contexthub node dist/cli.js list-clients
echo ""
echo "restore complete. Old database kept at $DB.pre-restore-$STAMP — remove it once verified."
