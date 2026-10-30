#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
for file in CONFIG.yaml .env; do
  [[ -f "$file" ]] || { echo "Missing required $file" >&2; exit 1; }
done
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
NODE="$(command -v node)"
USER_NAME="$(id -un)"
[[ -n "$NODE" && -n "$USER_NAME" ]] || exit 1
npm ci --ignore-scripts
npm test
UNIT="$(mktemp)"
trap 'rm -f "$UNIT"' EXIT
cat > "$UNIT" <<EOF
[Unit]
Description=Simple EMA100 RSI14 Futures Trading Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/simple-index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
# Keep the existing unit name so an installation can be updated without orphaning the old service.
sudo install -m 0644 "$UNIT" /etc/systemd/system/nine-ai-quant.service
sudo systemctl daemon-reload
sudo systemctl enable --now nine-ai-quant.service
sudo systemctl --no-pager status nine-ai-quant.service
