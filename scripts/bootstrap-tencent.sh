#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/lipaliu/tianzong-clip-workbench.git}"
APP_DIR="${APP_DIR:-/opt/tianclip}"
SWAP_SIZE="${SWAP_SIZE:-4G}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg ffmpeg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

if ! swapon --show --noheadings | grep -q .; then
  fallocate -l "${SWAP_SIZE}" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

mkdir -p "${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch origin
  git -C "${APP_DIR}" checkout main
  git -C "${APP_DIR}" pull --ff-only origin main
else
  git clone --branch main "${REPO_URL}" "${APP_DIR}"
fi

install -d -m 0700 "${APP_DIR}/secrets"

cat <<EOF
Bootstrap complete.

Next:
1. Write production secrets to ${APP_DIR}/.env.tencent
2. Upload the pinned private core to Tencent COS
3. Run:
   cd ${APP_DIR}
   docker compose --env-file .env.tencent -f docker-compose.tencent.yml up -d --build
EOF
