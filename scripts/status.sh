#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."

for name in web api trader; do
  pid_file="logs/${name}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    printf '%-7s running (pid %s)\n' "$name" "$(cat "$pid_file")"
  elif systemctl --user is-active --quiet "trendboss-testnet-${name}.service" 2>/dev/null; then
    printf '%-7s running (systemd)\n' "$name"
  else
    printf '%-7s stopped\n' "$name"
  fi
done
