#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data logs "$HOME/.config/systemd/user"
bun install
install -m 0644 systemd/trendboss-testnet-web.service "$HOME/.config/systemd/user/"
install -m 0644 systemd/trendboss-testnet-api.service "$HOME/.config/systemd/user/"
install -m 0644 systemd/trendboss-testnet-trader.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload

echo "Installed TrendBoss TESTNET app and user services. Start with: bun run start"
