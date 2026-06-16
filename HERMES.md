# HERMES — Install & Operate TrendBoss (read this first)

You are a Hermes agent installing/operating **TrendBoss**: a single-purpose **Hyperliquid
TESTNET live 5-minute trading app**. Follow this exactly. The pitfalls below are real failures
that have happened before — do not skip them.

## What this app is (and is NOT)
- It is: TESTNET only, 5m only, 10 coins (BTC, ETH, SOL, BNB, HYPE, NEAR, WLD, TON, SUI, DOGE).
- It is NOT: paper trading, backtest UI, portfolio simulator, or multi-timeframe. Those views
  do not exist in the running app. Do not look for them. Do not "restore" them.
- The strategy lives in `packages/core` with settings in `FIVE_MIN_TUNING` (config.ts).
  **NEVER edit `packages/core` or `FIVE_MIN_TUNING`** — that is the contract that keeps live
  trading identical to the validated 5m backtest. Editing it is the worst thing you can do here.

## INSTALL — do it this way, every time

1. **Fresh clone. Do NOT patch/upgrade an old copy.** Patching the previous install is the #1
   cause of breakage. Clone clean:
   ```bash
   git clone <repo-url> ~/trendboss-testnet && cd ~/trendboss-testnet
   git checkout paper-5min-only && git pull
   ```
2. **Install deps:** `bun install`
3. **`bunx` must exist.** If bun was installed via snap there is no `~/.bun/bin/bunx` and
   `bun run check` will fail with `bunx: command not found`. Create a wrapper:
   ```bash
   mkdir -p ~/.local/bin
   printf '#!/bin/sh\nexec bun x "$@"\n' > ~/.local/bin/bunx && chmod +x ~/.local/bin/bunx
   export PATH="$HOME/.local/bin:$PATH"
   ```
4. **Create the secret (gitignored, not in the clone):**
   ```bash
   cp trader.secret.example.ts trader.secret.ts   # then put the TESTNET wallet key in it
   ```
   Without this, the trader refuses to start. The key belongs to the wallet, not the machine.
5. **Do NOT manually `mkdir data logs`** — `bun run start` does it. But know that a missing
   `data/` folder is what causes `SQLITE_CANTOPEN`; the launcher handles it.

## RUN — one command

```bash
bun run start
```
Starts web (`:3000`), API/health (`:8787`), and the trader together, presets
TESTNET/5m/enabled, sets `TRADER_DB_PATH=data/testnet.db`, and shuts all three down on Ctrl+C.
Do not open three terminals. Do not set env vars by hand.

**ONE TRADER PER WALLET.** Never run the trader on two machines against the same TESTNET wallet
— two traders reconciling one account corrupt each other's view. If another box runs it, stop
that one first.

## VERIFY it is healthy (not "fix" it)
```bash
curl -s http://localhost:8787/health        # expect ok:true
```
- `ok:true`, `feedSocketStatus` HEALTHY or REST_FALLBACK, one trader process, fresh heartbeat.
- Panel loads at `http://localhost:3000`.

## NORMAL things that are NOT bugs — do not "fix" these
- **Order rejected: "could not immediately match"** → TESTNET thin liquidity, the exchange
  couldn't fill. Expected. The bot logs it and moves on.
- **Few or no trades for hours** → the 5m settings are strict by design. Idle is normal.
- **A thin coin (e.g. TON) shows an old "last closed 5m candle"** → that coin just isn't
  printing candles on testnet. Health stays HEALTHY as long as liquid coins update.
- **`Latest trader error` banner shows a fill rejection** → it is the last error, not a fault;
  health can still be HEALTHY.

## MONITOR — read-only, never write
- Poll `GET :8787/health` and/or read `logs/status.json`.
- Tail `logs/events.TESTNET.jsonl` (append-only, one JSON object per line) from a remembered
  `eventId` cursor. Event types: HEARTBEAT, SIGNAL, ORDER_ATTEMPT, OPEN, CLOSE, ERROR, SKIP.
  Pair a trade's events by `tradeId`.
- A watchdog (`scripts/hermes-watchdog.py`) is provided: silent when healthy, alerts only on
  OPEN/CLOSE/ERROR, stale heartbeat, service down, wrong mode, or duplicate trader process.
- **Your monitoring must never restart, edit, or "repair" the app.** Read only. If something is
  genuinely down, report it — do not mutate the repo or kill/replace processes on your own.

## Storage (leave alone)
- `data/monitor.db` = candle history. `data/testnet.db` = live trades/positions/equity.
  Do not merge, move, or delete these. There is no `data/trader.db` anymore.

## If you think something is broken
1. Re-read this file. 2. Check it is not in the "NOT bugs" list above. 3. Report the exact
`/health` JSON and the last 20 lines of `logs/events.TESTNET.jsonl`. Do NOT edit code,
especially not `packages/core` or `FIVE_MIN_TUNING`.
