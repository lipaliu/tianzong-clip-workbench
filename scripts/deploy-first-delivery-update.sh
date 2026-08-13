#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="${TIANCLIP_APP_DIR:-/opt/tianclip/processor}"
SOURCE_REF="${TIANCLIP_SOURCE_REF:-a0f85a8}"
RAW_BASE="https://raw.githubusercontent.com/lipaliu/tianzong-clip-workbench/${SOURCE_REF}/processor"
BACKUP_DIR="${APP_DIR}/.deploy-backups/first-delivery-$(date +%Y%m%d-%H%M%S)"
FILES=(
  "src/config.ts"
  "src/candidate-analysis.ts"
  "src/engine-artifacts.ts"
  "src/pipeline/candidates.mjs"
  "src/repository.ts"
  "src/worker.ts"
)

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This deployment must run as root." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "Processor directory does not exist: $APP_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

restore_previous_version() {
  local file
  echo "Deployment failed; restoring the previous processor files." >&2
  for file in "${FILES[@]}"; do
    if [[ -f "$BACKUP_DIR/$file" ]]; then
      install -D -m 0644 "$BACKUP_DIR/$file" "$APP_DIR/$file"
    fi
  done
  (
    cd "$APP_DIR"
    npm run build >/dev/null
  ) || true
  systemctl restart tianclip-api tianclip-worker || true
}

trap restore_previous_version ERR

for file in "${FILES[@]}"; do
  install -D -m 0644 "$APP_DIR/$file" "$BACKUP_DIR/$file"
  temp_file="$(mktemp)"
  curl --fail --silent --show-error --location "${RAW_BASE}/${file}" --output "$temp_file"
  install -m 0644 "$temp_file" "$APP_DIR/$file"
  rm -f "$temp_file"
done

(
  cd "$APP_DIR"
  npm run build
)

systemctl restart tianclip-api tianclip-worker
sleep 3
systemctl is-active --quiet tianclip-api
systemctl is-active --quiet tianclip-worker
curl --fail --silent --show-error http://127.0.0.1:10000/readyz >/dev/null

trap - ERR
echo "Progressive-delivery update is live. Backup: $BACKUP_DIR"
