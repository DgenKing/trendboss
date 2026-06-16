#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."
mkdir -p data logs

export APP_MODE=TESTNET
export HYPERLIQUID_ENV=TESTNET
export TRADER_MODE=TESTNET
export TRADER_ENABLED=true
export TRADE_INTERVAL=5m
export COINS=BTC,ETH,SOL,BNB,HYPE,NEAR,WLD,TON,SUI,DOGE
export TRADER_DB_PATH=data/testnet.db
export DB_PATH=data/monitor.db

declare -a pids=()

start_component() {
  local name="$1"
  shift
  "$@" > >(sed -u "s/^/[$name] /") 2> >(sed -u "s/^/[$name] /" >&2) &
  local pid=$!
  pids+=("$pid")
  printf '%s\n' "$pid" > "logs/${name}.pid"
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${pids[@]}" 2>/dev/null || true
  rm -f logs/web.pid logs/api.pid logs/trader.pid
}

trap cleanup EXIT INT TERM

start_component api bun run packages/monitor/index.ts
start_component web bash -c "cd packages/web && exec bun run dev -- --port 3000"
start_component trader bun run packages/trader/index.ts

wait "${pids[@]}"
