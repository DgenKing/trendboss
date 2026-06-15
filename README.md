<p align="center">
  <img src="docs/trendboss-banner.svg" alt="TrendBoss" width="100%">
</p>

# TrendBoss

## Hermes-facing Hyperliquid TESTNET 5-minute trader

**One strategy. Ten markets. TESTNET only.**

> [!WARNING]
> TrendBoss signs and submits real orders to Hyperliquid TESTNET using your local agent key. TESTNET uses test funds, but keys must still be protected. This application deliberately refuses MAINNET operation and has no withdrawal path.

## What This App Is

TrendBoss is a single-purpose live trading service for Hyperliquid TESTNET. It trades a shared five-minute strategy across:

`BTC`, `ETH`, `SOL`, `BNB`, `HYPE`, `NEAR`, `WLD`, `TON`, `SUI`, and `DOGE`.

The app runs three processes together:

- **Trader** - consumes market data, evaluates the strategy, sizes positions, places TESTNET orders, and reconciles exchange state.
- **API** - exposes the strict live health contract and a cursor-based event feed on port `8787`.
- **Web** - displays only live TESTNET trader state and events on port `3000`.

It is designed to be operated alongside Hermes. Hermes can poll `/health` and consume the append-only event log through the included read-only watchdog. Hermes does not send trading commands, restart services, or write application state; TrendBoss remains the execution owner.

There is no PAPER mode, backtest tab, portfolio view, replay view, timeframe selector, or mixed historical/live data in the running application. Backtest and PAPER-related code retained in the repository is development infrastructure, not a runtime mode.

## Trading Model

The live trader reuses the strategy engine and `FIVE_MIN_TUNING` from `packages/core`. This is intentional: the TESTNET path and the five-minute backtest share signal generation, indicators, level detection, and portfolio sizing logic.

For every configured coin, TrendBoss uses:

- **5-minute candles** for entries, exits, and trade management.
- **1-hour candles** for trend and range regime classification.
- **1-day candles** for prior-day range levels.
- **Pivot swing levels** derived by the shared level engine.
- **Trend momentum entries** after a confirmed breakout in the matching regime.
- **Range reversion entries** after a level touch, confirmation, trigger, and score threshold.

The market feed backfills `5m`, `1h`, and `1d` candles, then follows Hyperliquid TESTNET through WebSocket subscriptions. Closed-candle REST polling remains active as a fallback and reconciliation source. Candles are deduplicated before being stored or evaluated.

### Active Risk Defaults

| Setting | Value |
| --- | ---: |
| Starting-equity fallback | `$1,000` |
| Leverage | `5x` isolated |
| Risk per trade | `2%` of equity |
| Maximum margin per position | `25%` of equity |
| Maximum total used margin | `100%` of equity |
| Maximum open positions | `10` |
| Active positions per coin | `1` |
| Sizing fee assumption | `0.035%` per side |
| Sizing slippage assumption | `0.015%` per side |

Do not change `FIVE_MIN_TUNING` casually. Its values are part of the live/backtest parity contract.

## TESTNET Execution

TrendBoss uses a local Hyperliquid agent key and account address to place plain perpetual orders on TESTNET. HIP-3 markets are not supported.

An accepted entry is submitted as a grouped order containing:

1. An IOC entry with a protected limit price.
2. A reduce-only stop-loss trigger.
3. A reduce-only take-profit trigger.

If the entry fills without both protective orders being confirmed, the trader cancels the incomplete protection and attempts to close the orphaned position. Normal closes cancel remaining triggers and submit a reduce-only IOC order.

Every heartbeat reconciles local state against Hyperliquid positions, open orders, fills, margin, and account equity. Exchange state is authoritative when local and remote state disagree.

## Architecture

```text
Hyperliquid TESTNET
    |  candles, mids, account state, orders, fills
    v
Trader
    |-- shared strategy engine in packages/core
    |-- data/monitor.db       candle history
    |-- data/testnet.db       positions, trades, fills, decisions, equity
    |-- logs/events.TESTNET.jsonl
    |-- logs/status.json
    |
    v
API (:8787) <---------- Web dashboard (:3000)
    |
    +-- GET /health
    +-- GET /events
    |
    v
Hermes / hermes-watchdog.py (read-only observer)
```

## Requirements

- Linux or another environment capable of running the shell scripts
- [Bun](https://bun.sh/)
- Python 3 for the Hermes watchdog
- `curl` for the health helper
- A funded Hyperliquid TESTNET account and API agent key
- User-level systemd, if using the included service units

## Quick Start

Install dependencies and prepare the optional user services:

```bash
bun run install:app
```

Create the gitignored secret file:

```bash
cp trader.secret.example.ts trader.secret.ts
```

Edit `trader.secret.ts` with your TESTNET agent key and the TESTNET account address that owns the funds:

```ts
export const TESTNET_AGENT_KEY = "0x...";
export const TESTNET_ACCOUNT_ADDRESS = "0x...";
```

Start the web app, API, and trader together:

```bash
bun run start
```

Open `http://localhost:3000`. The health endpoint is available at `http://localhost:8787/health`.

`bun run start` creates `data/` and `logs/`, forces TESTNET mode, enables the trader, selects the five-minute interval and all ten coins, and uses the two separate databases described below.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run install:app` | Install dependencies and copy the user systemd units |
| `bun run start` | Start web, API, and trader together |
| `bun run stop` | Stop processes recorded by the start script and known user services |
| `bun run status` | Show local PID and user-service status |
| `bun run health` | Fetch and print `/health` |
| `bun run web` | Start only the dashboard |
| `bun run api` | Start only the health/event API |
| `bun run trader` | Start only the trader; required TESTNET environment must be set |

The supported operator path is `bun run start`. Running the trader directly requires `TRADER_ENABLED=true`, and the process still refuses any mode other than `TESTNET` or interval other than `5m`.

## User Services

The repository includes three user-level systemd units:

- `trendboss-testnet-web.service`
- `trendboss-testnet-api.service`
- `trendboss-testnet-trader.service`

After `bun run install:app`, enable and start them with:

```bash
systemctl --user enable --now trendboss-testnet-web.service
systemctl --user enable --now trendboss-testnet-api.service
systemctl --user enable --now trendboss-testnet-trader.service
```

Each unit uses `Restart=always`, waits five seconds before restarting, and explicitly sets TESTNET, enabled, and `5m` environment values.

The checked-in units currently use `/home/user/projects/trendboss` as `WorkingDirectory`. Update that path in `systemd/*.service` before installation if the repository lives elsewhere.

## Hermes Integration

`scripts/hermes-watchdog.py` is the read-only bridge intended for Hermes supervision. It polls health, tails the TESTNET event log from an event cursor, and never writes to or restarts TrendBoss.

Run continuously:

```bash
python3 scripts/hermes-watchdog.py
```

Run once from a Hermes schedule or automation step:

```bash
python3 scripts/hermes-watchdog.py --once
```

Healthy operation produces no output. The watchdog prints a short alert only for:

- `OPEN`, `CLOSE`, or `ERROR` events
- service unavailability
- wrong application mode
- duplicate trader processes
- a stopped trader
- stale heartbeat or market feed

Supported watchdog environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRENDBOSS_HEALTH_URL` | `http://localhost:8787/health` | Health endpoint to poll |
| `TRENDBOSS_EVENT_LOG` | `logs/events.TESTNET.jsonl` | Event stream to tail |
| `TRENDBOSS_WATCHDOG_SECONDS` | `15` | Continuous polling interval |
| `HERMES_LAST_EVENT_ID` | unset | Initial event cursor supplied by the caller |

The cursor is remembered in memory for a continuous watchdog process. A one-shot scheduler should persist the last consumed `eventId` externally and pass it back through `HERMES_LAST_EVENT_ID`.

## Live API

### `GET /health`

Alias: `GET /api/status`.

The response includes:

- overall `ok` and `mode`
- one live state object for each of the ten coins
- price, last closed five-minute candle, position, last signal, and last order attempt per coin
- trader running state and trader process count
- feed socket status and heartbeat age
- equity, used margin, latest error, secret presence, and update time

`ok` is false when any controlling safety condition fails, including:

- mode is not `TESTNET`
- the trader process count is not exactly one
- the feed is stale
- the heartbeat is stale
- `trader.secret.ts` is missing

The same payload is written atomically to `logs/status.json` on every trader heartbeat.

### `GET /events`

Alias: `GET /api/events`.

Query parameters:

- `limit` - number of events to return, capped at `1000`
- `after` - return events after this numeric `eventId`

Events are read from `logs/events.TESTNET.jsonl`. Supported event types are `HEARTBEAT`, `SIGNAL`, `ORDER_ATTEMPT`, `OPEN`, `CLOSE`, `ERROR`, and `SKIP`.

`OPEN` records contain the full trade-forensics payload: stable identifiers, regime, strategy, direction, levels, risk, allocation, leverage, indicators, score, candle data, account context, and exchange order references. `CLOSE` records include the reason, PnL, and fees.

## Storage and Logs

| Path | Contents |
| --- | --- |
| `data/monitor.db` | Shared `5m`, `1h`, and `1d` candle history |
| `data/testnet.db` | Live TESTNET positions, closed trades, fills, decisions, equity, and heartbeat metadata |
| `logs/events.TESTNET.jsonl` | Append-only machine-readable event stream |
| `logs/events.TESTNET.manifest.json` | Event stream manifest and current cursor |
| `logs/status.json` | Latest strict health snapshot |
| `logs/TESTNET-YYYY-MM-DD.log` | Human-readable daily narrative log |

The candle and live-trade databases are intentionally separate. Do not merge them or reintroduce the retired `data/trader.db` path.

Generated databases, logs, and `trader.secret.ts` are gitignored.

## Dashboard

The page on port `3000` polls the live API every five seconds. It shows only data produced by the running TESTNET trader:

- API, mode, trader, feed, and heartbeat health
- account equity and used margin
- per-coin price, candle, position, signal, and order-attempt state
- open and recently closed TESTNET trades
- TESTNET event history and the latest error

Historical backtest results, simulated portfolios, PAPER data, replay controls, and alternate timeframe views are intentionally absent.

## Configuration

The start script and systemd units set the supported configuration. Useful environment variables for isolated development are:

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_MODE` / `TRADER_MODE` | `TESTNET` through start scripts | Trader refuses non-TESTNET modes |
| `HYPERLIQUID_ENV` | `TESTNET` | Documents the required exchange environment |
| `TRADER_ENABLED` | unset for direct invocation | Must be exactly `true` |
| `TRADE_INTERVAL` | `5m` | Trader refuses other intervals |
| `COINS` | all ten supported coins | `start.sh` pins the complete required list |
| `TRADER_DB_PATH` | `data/testnet.db` | Live trading database |
| `DB_PATH` | `data/monitor.db` | Candle database |
| `TRADER_HEARTBEAT_MS` | `60000` | Heartbeat and REST reconciliation cadence |
| `API_PORT` | `8787` | Health/event API port |

Hyperliquid TESTNET endpoints are fixed by the trader configuration. MAINNET is not an environment option for this application.

## Development Checks

The repository retains focused tests for the shared strategy engine, trader state, health contract, event log, and TESTNET executor behavior:

```bash
bun test
bun run check
```

These commands are development checks. They do not replace observing TESTNET exchange state, health, events, and protective orders during live operation.

## Troubleshooting

### Health reports `secretPresent: false`

Create `trader.secret.ts` from the example and provide a valid TESTNET agent key and funded account address. Never commit this file.

### Health reports the trader is down or duplicated

Use `bun run status` and ensure exactly one launch method is active. Do not run `bun run start` and the trader systemd service at the same time.

### Feed status is stale

Check network access to Hyperliquid TESTNET and inspect the daily log. The trader can report `REST_FALLBACK` while closed-candle REST polling remains current; this is a healthy degraded state.

### A systemd service starts in the wrong directory

Update the absolute `WorkingDirectory` and `ExecStart` paths in `systemd/*.service`, then rerun `bun run install:app` and reload the user daemon.

## Safety and Disclaimer

TrendBoss is experimental trading software. TESTNET limits financial exposure, but it does not make poor operational security harmless. Protect private keys, use a dedicated TESTNET agent, confirm the account address, and inspect health and exchange state before relying on automation.

This software is provided for research and development and is not financial advice.
