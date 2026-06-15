# PAPER FIVE MIN ONLY

**Branch:** `paper-5min-only` (off `paper-trade`)
**Author:** DgenKing (via Claude)
**Status:** Spec for Codex — not yet implemented
**This file is the single source of truth for this branch.** Spec, plan, and running change
log all live here. It is intentionally separate from the `paper-trade` branch docs/UPDATES.md.

---

## 1. What this branch is for

One focused job: run the validated **5m strategy** as a live trader, in **PAPER** or
**TESTNET** mode (one or the other, never merged), and **log everything about every trade**
so any trade can be fully debugged after the fact.

We keep the chart/dashboard, but the whole project is pinned to the **5m timeframe only**.
This is a validation/observation build: leave it running, capture a complete forensic record,
compare simulated (PAPER) fills against real testnet fills on the *same* signals.

## 2. NON-NEGOTIABLE CONSTRAINTS

1. **5m only.** The trader already hard-fails if `tradeInterval !== '5m'`. Keep that. The
   strategy/tuning must remain the shared `FIVE_MIN_TUNING` object so live signals are
   identical to the 5m backtest. Do not fork a second tuning block.
2. **Run one mode or the other — never merged.** `TRADER_MODE=PAPER` and
   `TRADER_MODE=TESTNET` each run as their own single-mode process, exactly as today. Do NOT
   build a combined dual-executor loop.
3. **Do not change the strategy engine logic** (`packages/core`). Capturing indicator data
   for the log means *carrying existing computed values along* into the trade record — not
   changing how signals are generated. If live signals change, that's a bug.
4. **Additive logging.** Logging must not alter trade behaviour. If logging fails, the trade
   still proceeds; log the logging failure, never crash the loop over it.

## 3. Run modes (already supported — confirm, don't rebuild)

```bash
# PAPER (simulated fills)
TRADER_MODE=PAPER  TRADER_ENABLED=true TRADER_DB_PATH=data/paper.db   bun run trader
# TESTNET (real signed orders, fake money)
TRADER_MODE=TESTNET TRADER_ENABLED=true TRADER_DB_PATH=data/testnet.db bun run trader
```

- One mode per process. The executor is chosen once at startup (`PaperExecutor` vs
  `TestnetExecutor`).
- **Separate DB per mode** via `TRADER_DB_PATH` so paper and testnet state never collide
  (default is a single `data/trader.db` — set the path explicitly per mode).
- **Separate log files per mode** (see §5).

## 4. Trade log — capture EVERYTHING (the core of this branch)

Two log artifacts per mode, append-only, written to a `logs/` directory:

### a) Structured trade log — EVENT-BASED JSON Lines (`logs/trades-<mode>.jsonl`)

> **Contract confirmed by Hermes (the consuming agents) 2026-06-10.** This is the binding
> format. It is **one line per EVENT**, NOT one line per trade.

**Consumption model the format must serve:**
- Agents **poll / read on demand** (not live-tail as the only source of truth). The file is
  **append-only** and must support **incremental reads via a cursor**: every line carries a
  monotonic `eventId` (and `ts`) so an agent can resume from `last_seen_id` / `last_seen_ts`.
- The log must let an agent answer: current open position; what changed since last read; why a
  trade opened/skipped/rejected; today's realized + unrealized P&L; what happened on a given
  `tradeId`; whether an order send failed and why; whether the bot is healthy or stale.

**Event model — one line per event, paired by a stable `tradeId`:**
- Event types: `OPEN`, `CLOSE`, `SKIP`, `ERROR`, `UPDATE` (UPDATE optional, for mark/heartbeat
  or intermediate state). Optionally also write a final **summarized CLOSE** record, but never
  rely on a single consolidated line — the per-event lines must stand alone so skip reasons,
  open reasons, and failure diagnostics are never lost.
- **`tradeId`** (UUID, immutable) appears on every line and pairs OPEN/UPDATE/CLOSE/SKIP for
  one trade. Also include when available: `signalId`, `orderId`, `exchangeOrderId`,
  `positionId`.

**File path & rotation:**
- Stable current path per mode. If rotated, keep a stable "current" symlink/path **or** a
  manifest/index file pointing at the active log so an agent always finds the live file.

**Minimum fields on EVERY event line:**
`eventId`, `ts`, `event`, `tradeId`, `symbol`, `venue` (PAPER/TESTNET), `timeframe` (`5m`),
`direction`, `strategy`, `status`, `price`, `size`, `stop`, `target`, `reason`,
`skip_reason` (on SKIP), `error` (on ERROR), `pnl` + `fees` (on CLOSE), `source`/`bot_name`.

**Types/consistency rules (so agents don't choke):**
- Numbers as JSON numbers, never strings (no `"0.06%"`). Timestamps in ONE format across all
  lines (epoch ms preferred). Prices raw, not pre-rounded. Stable key names, every line.

**Full debug payload — the OPEN event additionally carries everything below**
(this is the forensic record; CLOSE carries exit/pnl/fees). Every OPEN MUST include:

**Identity**
- `coin`, `mode` (PAPER/TESTNET), `strategy` (TREND_MOMENTUM / RANGE_REVERSION),
  `regime` (UPTREND/DOWNTREND/RANGE), `direction` (LONG/SHORT)
- `signalTime`, `entryTime`, `exitTime`

**Prices & risk**
- `entry`, `stop`, `target`, `exitPrice`, `exitReason` (TARGET/STOP/OPEN)
- `riskPerUnit` (|entry − stop|), `rMultiple`, `returnPct`, `durationCandles`

**Size & money**
- `quantity` (position size), `notional`, `margin`, `allocationPct`, `leverage`
- `entryFee`, `exitFee`, `totalFees`
- `realizedPnl`

**Indicators AT ENTRY (the key debug payload)**
- Full `IndicatorSnapshot`: `adx`, `rsi`, `atr`, `fastEma` (20), `slowEma` (50),
  `emaSlope`, `regime`, `ready` flag
- `score` (the signal score), `levelName`, `levelPrice` (which level triggered it)

**Account context at entry**
- `equityBefore`, `equityAfter`, `usedMargin`, `openPositionsCount`

**Triggering candle**
- `candle`: `{ openTime, closeTime, open, high, low, close, volume }`

> The point: from one line you can reconstruct exactly what the market, the indicators, and
> the account looked like at the moment a trade opened and closed.

### b) Plain narrative log — text (`logs/<mode>-YYYY-MM-DD.log`)
Append-only, **date-rolled** (new file per UTC day) so files don't grow unbounded. Captures
the full running narrative — everything currently sent to `console.log` plus:
- Every signal generated.
- Every **skipped** signal and the reason (ACTIVE_SYMBOL, MAX_POSITIONS, NO_MARGIN,
  PARTIAL_MARGIN, EXECUTOR_REJECTED) — the `LiveDecision` records.
- Every entry/exit fill (price, size, fees).
- Every reconciliation against the exchange (TESTNET).
- Every error / lastError.
- Heartbeats.

### c) SQLite DB (already exists) — third backup layer
The trader DB already persists positions, fills, closed trades, decisions, and equity points.
Keep it. It is the queryable structured backup; the JSONL is the analysis-friendly export; the
text log is the human narrative.

## 5. Implementation notes for Codex

- **Indicator snapshot threading:** the engine already computes `IndicatorSnapshot` per candle
  (`latestIndicatorAt(...)` in `packages/trader/index.ts`). Carry that snapshot (and the
  signal `score`/level) into the trade record when a position opens, so it lands in the JSONL.
  This is data plumbing in the trader only — do NOT modify `packages/core/strategy.ts` logic.
- **Logger module:** add one small logging module in `packages/trader` that exposes
  append-to-file for both the JSONL trade log and the date-rolled text log, keyed by mode.
  Wrap writes in try/catch — a logging failure must never break the trade loop.
- **Mode in paths:** derive `<mode>` from `config.trader.mode` so PAPER and TESTNET write to
  distinct files automatically.
- **Keep the chart/dashboard**, pinned to 5m. No need to delete `packages/web`.

## 6. Acceptance criteria

1. `TRADER_MODE=PAPER` and `TRADER_MODE=TESTNET` each run standalone; never a merged loop.
2. With separate `TRADER_DB_PATH`, paper and testnet state/logs do not collide.
3. The trade log is **event-based JSONL** (one line per `OPEN`/`CLOSE`/`SKIP`/`ERROR`), every
   line carries a monotonic `eventId` + `ts` (cursor support) and a stable UUID `tradeId`
   pairing the events of one trade.
4. `OPEN` events carry ALL §4a debug fields (entry indicator snapshot, size, stop/target,
   fees). `CLOSE` events record exit price, reason, R-multiple, realized P&L, total fees.
   `SKIP`/`ERROR` events carry `skip_reason`/`error`. Numbers are numeric, timestamps single
   format.
5. The text log is append-only and date-rolled per UTC day; it includes skipped-signal
   reasons.
6. Live 5m signals are still identical to the 5m backtest (shared `FIVE_MIN_TUNING`).
7. `bun run check` passes. No change to `packages/core` strategy logic.
8. A logging failure logs an error but does not stop trading.

---

## 8. TESTNET-ONLY SIMPLIFICATION — Spec for Codex

**Status:** Spec for Codex — not yet implemented.
**Goal:** Remove all confusion from the app. It becomes a single-purpose **Hyperliquid
TESTNET live 5m trading** app. One command starts everything. The web panel shows ONLY live
testnet state. PAPER mode, backtest, and portfolio disappear from the running app and the UI.

### 8.1 The single most important rule (do not break this)

**TESTNET must trade EXACTLY the same as the 5m backtest.** This is already true because the
live trader and the backtest share one strategy engine (`packages/core`) and one settings
object (`FIVE_MIN_TUNING` in `config.ts`). Therefore:

- **DO NOT delete or modify `packages/core`** (strategy, indicators, detect, levels, backtest).
  That shared engine is exactly what guarantees testnet == backtest. Deleting it would break
  the guarantee.
- **DO NOT change `FIVE_MIN_TUNING` or any of its values.**
- "Removing the backtest" means **removing it from the dashboard/UI only** — the backtest
  ENGINE code stays in the repo so the live strategy stays identical and so it can still be
  run on demand for validation.

If live signals stop matching the 5m backtest after this work, that is a bug.

### 8.2 Target scope

- Runtime mode: **TESTNET only.** No PAPER path runs.
- Exchange: **Hyperliquid testnet only.**
- Timeframe: **5m only** (regime on 1h, as today).
- Coins: **all 10 supported testnet coins** (BTC, ETH, SOL, BNB, HYPE, NEAR, WLD, TON, SUI,
  DOGE).
- **One web panel**, testnet-only.
- **No** backtest tab, **no** portfolio tab, **no** PAPER view, **no** timeframe selector.

### 8.3 One command runs everything

- `bun run` (define a clear script, e.g. `bun start` / `bun run all`) must launch **all three**
  processes together in one terminal: **monitor (feed + levels + API)**, **web (dashboard)**,
  and **trader (TESTNET)**. No more opening separate terminals.
- It must set the testnet/5m/enabled config automatically so the user does not pass env vars.
- Use a single supervisor (a small `bun` launcher script, or a process manager like
  `concurrently`) that starts the three, prefixes their logs, and shuts them all down together
  on Ctrl+C.
- Keep the existing `data/`/`logs/` auto-create so a fresh clone "just works" (the missing
  `data/` folder is what broke the laptop start — the launcher must `mkdir -p data logs`).
- The TESTNET DB path must be set to a fixed `data/testnet.db` by the launcher.

### 8.4 The one dashboard page — fields only

The panel reads **only** from the live TESTNET trader state/logs (DB + heartbeat + JSONL).
No backtest, no portfolio, no PAPER. **No confusion rule: if it is not from the live TESTNET
trader, it does not appear.** Show:

- service status (trader/monitor/web up, mode = TESTNET)
- heartbeat freshness (seconds since last heartbeat; stale warning)
- per coin / overall: symbol, current price, last closed 5m candle time
- current open position(s): entry, stop, target, size, margin, unrealized P&L, fees
- last signal (per coin): time, direction, strategy, score
- last order attempt + result (accepted / rejected + reason)
- open & closed TESTNET trades with P&L
- latest error

### 8.5 What to remove / hide

- Web UI: delete the Backtest, Portfolio, and any PAPER/timeframe-selector views/components and
  their API calls. The dashboard becomes the single testnet panel above.
- Monitor API: keep the endpoints the new panel needs (live testnet state, candles for price).
  The backtest/portfolio endpoints may stay in code but must not be surfaced in the UI; if they
  cause confusion they can be left unreferenced.
- Config: hard-lock `trader.mode = TESTNET`, `tradeInterval = '5m'`, `enabled = true` for the
  one-command launch (still allow an override if needed, but default to live testnet).

### 8.5b Databases — two clean ones, delete the rest

- **`data/monitor.db`** — candle store (price history the strategy needs). Keep.
- **`data/testnet.db`** — live TESTNET trade state (positions, fills, closed trades, equity,
  decisions). Keep. The launcher sets `TRADER_DB_PATH=data/testnet.db`.
- **Delete `data/trader.db`** — dead PAPER-era mixed-mode file; it is a source of confusion.
- Do NOT merge candles and trade state into one file — keeping price data separate from the
  trading record is intentional and reduces confusion.

### 8.5c Hermes monitoring surface

> **Superseded/expanded by §8.8 (FINAL).** §8.8 is the controlling spec for the health
> endpoint, event log, scripts, systemd, and watchdog. The notes below remain as background.

Hermes (Nous Research agent) has **no formal app-monitoring contract** — it monitors an app by
pointing a scheduled cron script at whatever stable, machine-readable output the app produces.
So we just expose clean, stable surfaces:

1. **Event JSONL log at a fixed path** (already specced in §4): `logs/trades-TESTNET.jsonl`,
   append-only, one event per line, `eventId` cursor, stable `tradeId`. Keep the manifest at
   `logs/trades-TESTNET.manifest.json` pointing at the active file. Do not move or rename these.
2. **One status snapshot** for cheap "is it alive / what's it doing" polling — provide BOTH:
   - `GET /api/status` returning the live testnet summary as JSON, AND
   - `logs/status.json` rewritten on every heartbeat (so a cron script can read a file without
     the web server).
   Contents (numbers as numbers, timestamps epoch-ms):
   `mode` (TESTNET), `tradeInterval` (5m), `heartbeatTs`, `secondsSinceHeartbeat`,
   `socketHealthy`, `coins`, `openPositionsCount`, `equity`, `usedMargin`, `lastSignal`,
   `lastOrderAttempt`, `lastError`, `signalsSeen`.
- Stable file paths, stable JSON keys, no breaking renames — a Hermes cron script depends on
  these staying put.

### 8.6 Acceptance criteria

1. A single command starts monitor + web + trader (TESTNET, 5m, 10 coins) in one terminal and
   stops them all on Ctrl+C.
2. Fresh clone works without manual `mkdir` (launcher creates `data/`+`logs/`).
3. The dashboard shows ONLY live testnet fields from §8.4; no backtest/portfolio/PAPER anywhere
   in the UI.
4. `packages/core` and `FIVE_MIN_TUNING` are unchanged; live 5m signals remain identical to the
   5m backtest.
5. Event-based JSONL + text logs (§4) still written for TESTNET.
6. Operational layer per §8.8: `GET :8787/health` returns strict JSON and `ok=false` on every
   listed failure (incl. wrong mode + duplicate trader process); `logs/status.json` rewritten
   each heartbeat; `logs/events.TESTNET.jsonl` (+ manifest) with the §8.8 event types;
   `scripts/` + package scripts present; 3 systemd services with `Restart=always`; read-only
   `hermes-watchdog.py` silent-when-healthy; web `:3000`, api `:8787`; `AGENTS.md` present.
7. `bun run start` brings up web + api + trader together; `bun run status` shows all three.
8. All 10 testnet coins traded; `/health` returns per-coin arrays (no hardcoded single symbol).
9. `bun run check` passes.

### 8.6b How to verify TESTNET == 5m backtest (must hold after the work)

1. **Startup receipt:** the trader logs `[trader] live tuning override:` showing the 5m values
   (`adxThreshold:38, rangeMaxAdx:16, rangeMinScore:80, touchTolerance:0.0006,
   confirmWithinCandles:3, breakoutLookback:80, rsiLongMin:62, rsiShortMax:38,
   targetR range:2.4/trend:2.2`). Different numbers = divergence.
2. **Shared source:** confirm both the backtest path and the trader read `FIVE_MIN_TUNING`
   and `packages/core` (no second strategy/tuning copy introduced).
3. **Trade-by-trade:** run the 5m backtest over a recent window; for each backtest trade on a
   testnet coin at a 5m timestamp, the live TESTNET JSONL must show the same OPEN (or a logged
   SKIP with reason). A backtest trade with no matching live OPEN/SKIP = bug.
   (Note: signals/trades must match; exact P&L may differ due to real fills/slippage/rejects.)

### 8.8 Operational layer (merged from Hermes agent recommendation) — FINAL

Hermes' agent proposed a solid DevOps layer. Adopt it, **amended** so it does not break the two
hard rules (reuse `packages/core`/`FIVE_MIN_TUNING`; strip, don't rebuild; keep 10 coins).

**Reconciled decisions where Hermes conflicted with this spec:**
- **STRIP, do not "rebuild from scratch."** Reuse the existing strategy engine and tuning. A
  green-field rebuild is forbidden — it would re-implement the strategy and break backtest
  parity (§8.1). This is the controlling instruction.
- **Keep all 10 testnet coins** (not one symbol). Therefore `/health` and `status.json` return
  per-coin **arrays** for price / position / last signal, plus portfolio-level equity/margin.
  (BTC-only would be a one-line coin-list change if ever wanted — do NOT hardcode a single
  symbol.)
- **Event log filename:** standardize on `logs/events.TESTNET.jsonl` (Hermes' watchdog reads
  this path). This supersedes the earlier `logs/trades-TESTNET.jsonl` name; keep the manifest
  alongside it. All §4 event rules (eventId cursor, tradeId, JSON types) still apply.

**`GET http://localhost:8787/health` — strict JSON.** Returns:
`ok`, `mode` (TESTNET), `coins[]`, per-coin `price`, `lastClosed5mCandle`, `position`,
`lastSignal`, `lastOrderAttempt`; plus `traderRunning`, `feedSocketStatus`, `heartbeatAgeSec`,
`equity`, `usedMargin`, `lastError`. **`ok` MUST be false (health fails) if:** mode ≠ TESTNET,
trader not running, feed stale, heartbeat stale, `trader.secret.ts` missing, or **more than one
trader process is running.** Also keep `logs/status.json` rewritten each heartbeat with the same
payload (file-based polling without the web server).

**Event log — `logs/events.TESTNET.jsonl`**, one JSON object per line. Event types:
`HEARTBEAT`, `SIGNAL`, `ORDER_ATTEMPT`, `OPEN`, `CLOSE`, `ERROR` (keep `SKIP` too — it carries
the skip reason). OPEN keeps the full forensic payload (§4a).

**Scripts (`scripts/`):** `install.sh`, `start.sh`, `stop.sh`, `status.sh`, `healthcheck.sh`,
`hermes-watchdog.py`. **package scripts:** `install:app`, `start`, `stop`, `status`, `health`,
`web`, `api`, `trader`. `bun run start` brings up web + api + trader together; `status` shows all
three; `health` prints the `/health` JSON. `start.sh` must `mkdir -p data logs` and set
`TRADER_DB_PATH=data/testnet.db`.

**systemd (user) services** — `trendboss-testnet-web.service`, `-api.service`, `-trader.service`,
each with `Restart=always`, `RestartSec=5`, `WorkingDirectory=<repo>`, and
`Environment=APP_MODE=TESTNET HYPERLIQUID_ENV=TESTNET TRADE_INTERVAL=5m`. This is the real fix
for "it keeps dying / I open too many terminals" — auto-restart + one `systemctl` command. (Note:
for `--user` services to run without an active login, enable lingering: `loginctl enable-linger`.)

**`scripts/hermes-watchdog.py` — READ-ONLY.** Polls `/health` and tails
`logs/events.TESTNET.jsonl` from a remembered cursor (`last_event_id`). Prints **nothing** when
healthy with no new noteworthy event; prints a short alert ONLY on `OPEN`, `CLOSE`, `ERROR`,
stale heartbeat, a service down, wrong mode, or a duplicate trader process. It must never write
to or restart the app.

**Ports:** web on `:3000`, api/health on `:8787`.

**AGENTS.md** at repo root: short operator guide — what the app is (TESTNET 5m only), the one
command to start, where logs/health live, and the "no confusion" rule.

### 8.7 Plan / order of work for Codex

1. Add the one-command launcher script (monitor + web + trader, env preset, `mkdir -p`,
   unified shutdown). Verify it starts all three.
2. Lock config to TESTNET/5m/enabled by default for the launcher.
3. Strip the web app to the single testnet panel (§8.4); remove backtest/portfolio/PAPER views
   and their data fetching.
4. Build the §8.8 operational layer: `:8787/health` (strict JSON + all failure conditions),
   `logs/status.json` per heartbeat, `logs/events.TESTNET.jsonl` with `HEARTBEAT`/`SIGNAL`/
   `ORDER_ATTEMPT`/`OPEN`/`CLOSE`/`ERROR`/`SKIP`, the `scripts/` + package scripts, 3 systemd
   services, read-only `hermes-watchdog.py`, and `AGENTS.md`. Confirm the panel reads only live
   testnet state (per-coin arrays).
5. Run `bun run check`; verify testnet still matches the 5m backtest (spot-check signals).
6. Append a dated entry to §7 of this file describing what was done + verification.

---

## 7. Running change log (newest first)

> Format: `### YYYY-MM-DD — short title` then a couple of bullets.

### 2026-06-15 — FINAL spec: merged Hermes ops layer (§8.8) before Codex build
- Reviewed Hermes agent's Codex recommendation. Adopted its ops layer: strict `:8787/health`
  JSON with hard failure conditions (wrong mode, trader down, stale feed/heartbeat, missing
  secret, duplicate trader process), 3 systemd services (`Restart=always`), `scripts/` +
  package scripts, event types `HEARTBEAT`/`SIGNAL`/`ORDER_ATTEMPT`/`OPEN`/`CLOSE`/`ERROR`,
  read-only silent-when-healthy `hermes-watchdog.py`, `AGENTS.md`, web `:3000` / api `:8787`.
- **Amended Hermes' two conflicts:** (1) STRIP, do not rebuild from scratch — reuse
  `packages/core` + `FIVE_MIN_TUNING` so testnet stays identical to the 5m backtest; (2) keep
  all 10 coins, so `/health` returns per-coin arrays (no hardcoded single symbol).
- Standardized event log path to `logs/events.TESTNET.jsonl`. Updated acceptance criteria +
  build steps. This is the final spec before Codex builds.

### 2026-06-15 — Added Hermes monitoring surface to the spec
- Checked official Nous Research Hermes docs: there is NO formal app-monitoring contract or
  standard project `hermes.config.yaml`. Hermes monitors via a cron script reading whatever
  stable output an app exposes (the laptop's hermes.config.yaml + watch script were bespoke).
- Added §8.5c: keep the fixed-path event JSONL + manifest, and add a status snapshot exposed
  BOTH as `GET /api/status` and `logs/status.json` (rewritten each heartbeat) with a defined
  testnet summary, stable JSON keys/paths. Added matching acceptance criterion + build step.

### 2026-06-15 — Spec'd TESTNET-only simplification (for Codex)
- Added §8: collapse the app to a single-purpose Hyperliquid **TESTNET live 5m** app — one
  command starts monitor+web+trader, one testnet-only dashboard, no PAPER/backtest/portfolio in
  the UI.
- Hard rule preserved: **testnet must trade identically to the 5m backtest**, so `packages/core`
  and `FIVE_MIN_TUNING` stay untouched (backtest ENGINE kept in repo; only removed from the UI).
- All 10 testnet coins kept. Defined the dashboard field list, the "no confusion" rule, the
  one-command launcher requirements, acceptance criteria, and Codex's order of work. Not yet
  implemented.

### 2026-06-10 — Implemented event-based trader logs
- Added `packages/trader/logger.ts` with safe append-only JSONL event logging at
  `logs/trades-<mode>.jsonl`, a manifest pointing at the active file, and date-rolled text
  logs at `logs/<mode>-YYYY-MM-DD.log`; write failures report to stderr and never throw.
- Wired live trader events for `OPEN`, `CLOSE`, `SKIP`, and `ERROR` with monotonic `eventId`,
  epoch-ms `ts`, stable UUID `tradeId`, signal/order/position IDs where available, and the
  Hermes minimum field set on every line.
- Threaded the already-computed live `IndicatorSnapshot` into the `OPEN` forensic payload
  with size, fees, account context, level, score, and candle data; `CLOSE` events carry
  exit price/reason, R multiple, realized P&L, and fees.
- Captured existing console narrative into date-rolled text logs, added explicit signal,
  decision, fill, and TESTNET reconciliation lines, kept PAPER/TESTNET single-mode operation
  and the shared 5m tuning untouched. Verified `bun run check` passes.

### 2026-06-10 — Adopted Hermes event-based log contract
- Hermes (the consuming agents) confirmed the log format: **event-based JSONL**, one line per
  `OPEN`/`CLOSE`/`SKIP`/`ERROR`/`UPDATE`, shared UUID `tradeId` pairing events, monotonic
  `eventId`+`ts` for cursor/incremental reads, agents poll/read-on-demand (not live-tail).
- Updated §4a to this binding contract: minimum per-event fields, type/timestamp consistency
  rules, stable current path + manifest on rotation, and the full debug payload on `OPEN`.
- **Note:** supersedes the earlier "one line per trade" wording. If Codex's in-flight pass
  built the per-trade form, it needs a follow-up pass to convert to event-based.

### 2026-06-10 — Branch spec created
- Created this file as the single doc for the `paper-5min-only` branch.
- Defined scope (5m only, PAPER or TESTNET run separately), the full trade-log requirements
  (JSONL with size/entry/stop/fees/indicators/account context + date-rolled text log + DB),
  and acceptance criteria. Handed to Codex; not yet implemented.

<!-- Add your next entry above this line -->
