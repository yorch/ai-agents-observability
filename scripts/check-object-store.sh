#!/usr/bin/env bash
# Preflight for the bundled object store. Run by the `just` recipes that start
# the stack, BEFORE `docker compose up`. Compose alone cannot express either check.
#
#   1. Data-loss guard. If ./data/minio holds data and the migration has not
#      COMPLETED (marker file below), the Garage store would start empty or
#      partial while the database still points at keys that live only in the old
#      MinIO directory, and /readyz would be green. Refuse and point at the
#      migration script. The marker, not "./data/garage is non-empty", is the
#      signal: a migration that died half-way, or one `docker compose up` run
#      outside `just`, leaves ./data/garage populated but incomplete.
#   2. Secret length. Garage refuses to start with a secret shorter than 16
#      characters (MinIO accepted 8+, and the old dev default was "minioadmin").
#
# Usage: scripts/check-object-store.sh [env-file]
# Overrides: OBJECT_STORE_ALLOW_EMPTY=1 skips (1) for people who truly want a
# fresh store and are discarding ./data/minio; it writes the marker so later
# runs do not need the variable again.
set -euo pipefail

ENV_FILE="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Last value of KEY in the env file (raw KEY=VALUE, optional quotes), else empty.
env_value() {
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  # Unquoted values: drop a trailing " # comment" the way Compose's env-file parser does.
  if [[ "$line" != \"* && "$line" != \'* ]]; then
    line="$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//')"
  fi
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

has_data() { [[ -d "$1" && -n "$(ls -A "$1" 2>/dev/null)" ]]; }

fail=0

# Written by scripts/migrate-minio-to-garage.sh only after the copy verified.
MARKER=data/garage/.minio-migration-complete

if has_data data/minio && [[ ! -f "$MARKER" && "${OBJECT_STORE_ALLOW_EMPTY:-0}" == "1" ]]; then
  mkdir -p data/garage
  echo "skipped: OBJECT_STORE_ALLOW_EMPTY=1 on $(date -u +%Y-%m-%dT%H:%M:%SZ); ./data/minio was NOT migrated" > "$MARKER"
  echo "WARNING: starting with an empty object store; ./data/minio was not migrated (recorded in $MARKER)." >&2
fi

if has_data data/minio && [[ ! -f "$MARKER" ]]; then
  if has_data data/garage; then
    state="./data/garage exists but no completed migration is recorded (a migration that
did not finish, or the new store was started outside \`just\`)"
  else
    state="./data/garage does not"
  fi
  cat >&2 <<MSG
ERROR: ./data/minio contains data but $state.

The bundled object store is now Garage and cannot read MinIO's on-disk format.
Starting now would give you an EMPTY store while your database still references
the old transcripts. Migrate first (your ./data/minio is never modified):

    ./scripts/migrate-minio-to-garage.sh ${ENV_FILE:-.env}

Guide: docs/deploy/migrate-from-minio.md
To start with an empty store and discard the old data, re-run with
OBJECT_STORE_ALLOW_EMPTY=1.
MSG
  fail=1
fi

secret="$(env_value S3_SECRET_ACCESS_KEY)"
[[ -n "$secret" ]] || secret="$(env_value MINIO_ROOT_PASSWORD)"
if [[ -n "$secret" && ${#secret} -lt 16 ]]; then
  cat >&2 <<MSG
ERROR: the object-store secret (S3_SECRET_ACCESS_KEY, or the legacy
MINIO_ROOT_PASSWORD) is ${#secret} characters. Garage requires at least 16 and
refuses to start otherwise. Generate one:

    openssl rand -hex 24

Any access key id is accepted. If this store has
already been started with a different secret, do NOT just edit the env file:
Garage crash-loops on a changed secret. Delete the old key first:
    docker compose exec object-store /garage key delete <old key id>
MSG
  fail=1
fi

if [[ -n "$(env_value MINIO_ROOT_USER)$(env_value MINIO_ROOT_PASSWORD)" ]] \
  && [[ -z "$(env_value S3_ACCESS_KEY_ID)" || -z "$(env_value S3_SECRET_ACCESS_KEY)" ]]; then
  echo "WARNING: MINIO_ROOT_USER/MINIO_ROOT_PASSWORD are deprecated; set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY." >&2
fi

exit "$fail"
