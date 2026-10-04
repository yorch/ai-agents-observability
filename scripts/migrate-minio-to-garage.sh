#!/usr/bin/env bash
# One-shot migration of the bundled object store from MinIO to Garage.
#
# Garage cannot read MinIO's on-disk format, so this is a COPY: the old
# ./data/minio is served by a throwaway MinIO container and `rclone copy
# --metadata` streams every object into a throwaway Garage container that is
# backed by the real ./data/garage. The copy is then verified object by object
# (size AND user metadata) and the script exits non-zero on any difference.
#
# ./data/minio is NEVER modified or deleted. By default the source container
# runs on a private COPY of it (MinIO rewrites .minio.sys on startup); set
# MIGRATION_SOURCE_INPLACE=1 to mount it read-only instead and skip the copy
# (needs no spare disk, but MinIO may refuse to start on a read-only volume).
#
# Prerequisites: docker, bun, and the stack STOPPED (no writers):
#     just prod-down      # or: just dev-down / just dev-infra-down
#
# Usage: scripts/migrate-minio-to-garage.sh [env-file]     (default: .env)
#
# Environment:
#   MIGRATION_SOURCE_IMAGE   MinIO image serving the old data
#                            (default: pgsty/minio:RELEASE.2026-08-04T00-00-00Z;
#                             upstream quay.io/minio and Docker Hub minio/minio
#                             images are no longer pullable)
#   OBJECT_STORE_IMAGE       Garage image (default: same as docker-compose.infra.yml)
#   MIGRATION_RCLONE_IMAGE   default: rclone/rclone:1.75.1
#   OLD_MINIO_USER/OLD_MINIO_PASSWORD
#                            credentials of the OLD MinIO (default: MINIO_ROOT_USER /
#                            MINIO_ROOT_PASSWORD from the env file, else minioadmin)
#   MIGRATION_SOURCE_INPLACE=1   see above
set -euo pipefail

ENV_FILE="${1:-.env}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SOURCE_IMAGE="${MIGRATION_SOURCE_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}"
GARAGE_IMAGE="${OBJECT_STORE_IMAGE:-dxflrs/garage:v2.4.1}"
RCLONE_IMAGE="${MIGRATION_RCLONE_IMAGE:-rclone/rclone:1.75.1}"
# Same fixed constant as docker-compose.infra.yml (RPC is loopback-only).
RPC_SECRET="${GARAGE_RPC_SECRET:-0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0}"

die() { echo "ERROR: $*" >&2; exit 1; }

env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
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

command -v docker >/dev/null || die "docker is required"
command -v bun >/dev/null || die "bun is required (used to diff the two object listings)"
[[ -f "$ENV_FILE" ]] || die "env file '$ENV_FILE' not found (pass it as the first argument)"
[[ -d data/minio && -n "$(ls -A data/minio 2>/dev/null)" ]] || die "./data/minio is missing or empty; nothing to migrate"

BUCKET="$(env_value S3_BUCKET)"; BUCKET="${BUCKET:-transcripts}"
NEW_KEY="$(env_value S3_ACCESS_KEY_ID)"; [[ -n "$NEW_KEY" ]] || NEW_KEY="$(env_value MINIO_ROOT_USER)"; NEW_KEY="${NEW_KEY:-devaccesskey}"
NEW_SECRET="$(env_value S3_SECRET_ACCESS_KEY)"; [[ -n "$NEW_SECRET" ]] || NEW_SECRET="$(env_value MINIO_ROOT_PASSWORD)"
[[ -n "$NEW_SECRET" ]] || die "S3_SECRET_ACCESS_KEY is not set in $ENV_FILE"
(( ${#NEW_SECRET} >= 16 )) || die "S3_SECRET_ACCESS_KEY must be at least 16 characters for Garage (generate one with: openssl rand -hex 24)"
OLD_USER="${OLD_MINIO_USER:-$(env_value MINIO_ROOT_USER)}"; OLD_USER="${OLD_USER:-minioadmin}"
OLD_PASS="${OLD_MINIO_PASSWORD:-$(env_value MINIO_ROOT_PASSWORD)}"; OLD_PASS="${OLD_PASS:-minioadmin}"

for svc in ingest web minio object-store; do
  if [[ -n "$(docker ps -q --filter "label=com.docker.compose.service=$svc")" ]]; then
    die "a '$svc' container is running. Stop the stack first (just prod-down / just dev-down) so nothing writes during the copy."
  fi
done

if [[ -d data/garage && -n "$(ls -A data/garage 2>/dev/null)" ]]; then
  echo "NOTE: ./data/garage already has data; continuing (the copy is restartable and --immutable)."
fi

RUN_ID="aao-migrate-$$"
NET="$RUN_ID-net"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXXXX")"
SRC_DIR="data/minio"
SRC_COPY=""
cleanup() {
  docker rm -f "$RUN_ID-src" "$RUN_ID-dst" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ -z "$SRC_COPY" ]] || rm -rf "$SRC_COPY" || echo "NOTE: could not remove $SRC_COPY (root-owned files from the scratch MinIO); delete it with sudo." >&2
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Pulling images ($SOURCE_IMAGE, $GARAGE_IMAGE, $RCLONE_IMAGE)"
docker pull "$SOURCE_IMAGE" >/dev/null || die "cannot pull $SOURCE_IMAGE; set MIGRATION_SOURCE_IMAGE to a MinIO image you can pull"
docker pull "$GARAGE_IMAGE" >/dev/null
docker pull "$RCLONE_IMAGE" >/dev/null

docker network create "$NET" >/dev/null

if [[ "${MIGRATION_SOURCE_INPLACE:-0}" == "1" ]]; then
  echo "==> Serving ./data/minio read-only (MIGRATION_SOURCE_INPLACE=1)"
  SRC_MOUNT="$ROOT/data/minio:/data:ro"
else
  SRC_COPY="$ROOT/data/.minio-migration-src"
  rm -rf "$SRC_COPY"
  echo "==> Copying ./data/minio to a private scratch dir (needs as much free disk as the old store; removed on exit)"
  cp -a data/minio "$SRC_COPY" || die "could not copy ./data/minio (root-owned files? re-run with sudo, or use MIGRATION_SOURCE_INPLACE=1)"
  SRC_MOUNT="$SRC_COPY:/data"
fi

echo "==> Starting the old MinIO as the copy source"
docker run -d --name "$RUN_ID-src" --network "$NET" --network-alias src \
  -e MINIO_ROOT_USER="$OLD_USER" -e MINIO_ROOT_PASSWORD="$OLD_PASS" \
  -v "$SRC_MOUNT" "$SOURCE_IMAGE" server /data >/dev/null

echo "==> Starting Garage on ./data/garage"
mkdir -p data/garage/meta data/garage/data
docker run -d --name "$RUN_ID-dst" --network "$NET" --network-alias dst \
  -e GARAGE_DEFAULT_ACCESS_KEY="$NEW_KEY" -e GARAGE_DEFAULT_SECRET_KEY="$NEW_SECRET" \
  -e GARAGE_DEFAULT_BUCKET="$BUCKET" -e GARAGE_RPC_SECRET="$RPC_SECRET" \
  -v "$ROOT/infra/garage/garage.toml:/etc/garage.toml:ro" \
  -v "$ROOT/data/garage/meta:/var/lib/garage/meta" \
  -v "$ROOT/data/garage/data:/var/lib/garage/data" \
  "$GARAGE_IMAGE" /garage -c /etc/garage.toml server --single-node --default-bucket >/dev/null

echo "==> Waiting for Garage"
ok=0
for _ in $(seq 1 60); do
  if docker exec "$RUN_ID-dst" /garage -c /etc/garage.toml health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[[ "$ok" == 1 ]] || { docker logs "$RUN_ID-dst" 2>&1 | tail -20 >&2; die "Garage did not become healthy"; }

# rclone remotes via environment; no config file. Path-style addressing; the
# region matches infra/garage/garage.toml.
rclone() {
  docker run --rm --network "$NET" -v "$WORK:/work" \
    -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Minio \
    -e RCLONE_CONFIG_SRC_ENDPOINT=http://src:9000 -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$OLD_USER" \
    -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$OLD_PASS" -e RCLONE_CONFIG_SRC_REGION=us-east-1 \
    -e RCLONE_CONFIG_SRC_FORCE_PATH_STYLE=true \
    -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=Other \
    -e RCLONE_CONFIG_DST_ENDPOINT=http://dst:9000 -e RCLONE_CONFIG_DST_ACCESS_KEY_ID="$NEW_KEY" \
    -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$NEW_SECRET" -e RCLONE_CONFIG_DST_REGION=us-east-1 \
    -e RCLONE_CONFIG_DST_FORCE_PATH_STYLE=true \
    "$RCLONE_IMAGE" "$@"
}

echo "==> Waiting for the source MinIO"
ok=0
for _ in $(seq 1 30); do
  if rclone lsd "src:" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[[ "$ok" == 1 ]] || { docker logs "$RUN_ID-src" 2>&1 | tail -20 >&2; die "the old MinIO did not start (wrong OLD_MINIO_USER/OLD_MINIO_PASSWORD?)"; }

echo "==> Copying src:$BUCKET -> dst:$BUCKET"
# --metadata is NOT optional: without it every user-metadata field (the
# upload-sha256 the idempotency check reads) is dropped, and `rclone check`
# would still report success.
rclone copy --metadata --immutable --checkers 8 --transfers 8 --stats 10s --stats-one-line \
  "src:$BUCKET" "dst:$BUCKET"

echo "==> Verifying (full size + metadata diff; this is not 'rclone check')"
rclone lsjson -R -M --files-only "src:$BUCKET" > "$WORK/src.json"
rclone lsjson -R -M --files-only "dst:$BUCKET" > "$WORK/dst.json"
bun run scripts/verify-object-copy.ts "$WORK/src.json" "$WORK/dst.json" \
  || die "verification FAILED. Garage data in ./data/garage is partial; ./data/minio is untouched. Re-run, or see docs/deploy/migrate-from-minio.md."

# The start-up preflight (scripts/check-object-store.sh) keys on this marker,
# not on ./data/garage being non-empty, so a half-finished run cannot pass it.
echo "verified $(date -u +%Y-%m-%dT%H:%M:%SZ) from $SOURCE_IMAGE" > data/garage/.minio-migration-complete \
  || die "copy verified, but could not write data/garage/.minio-migration-complete (root-owned ./data/garage?). Create it with sudo; the start recipes refuse to run without it."

cat <<MSG

Copy verified. Next:
  1. Cross-check against the database (objects are NOT 1:1 with sessions):
       SELECT count(*) FROM sessions WHERE transcript_s3_key IS NOT NULL;  -- vs transcripts/ above
       SELECT count(DISTINCT rationale_ref) FROM scores WHERE rationale_ref IS NOT NULL;  -- vs judge-rationales/ above
     (The destination may legitimately hold fewer if the DB never referenced
     some source objects, or more if rows were already deleted; investigate
     any other gap before deleting the old store.)
  2. Make sure your env file uses S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.
  3. Start the stack:  just prod-up   (or dev-up / dev-infra-up)
  4. Keep ./data/minio until you are satisfied; this script never deletes it.
MSG
