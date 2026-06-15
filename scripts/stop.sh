#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."

systemctl --user stop trendboss-testnet-web.service trendboss-testnet-api.service trendboss-testnet-trader.service 2>/dev/null || true

for name in web api trader; do
  pid_file="logs/${name}.pid"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
done
