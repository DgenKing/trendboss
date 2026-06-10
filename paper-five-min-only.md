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

### a) Structured trade log — JSON Lines (`logs/trades-<mode>.jsonl`)
One JSON object per line, one line per trade **at open** and an updated/closing line **at
close** (or: a single line written at close with full lifecycle — Codex's call, but it must
contain everything below). Every trade record MUST include:

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
3. Every opened trade produces a JSONL line containing ALL §4a fields — including the entry
   indicator snapshot and fees.
4. Every closed trade records exit price, reason, R-multiple, realized P&L, and total fees.
5. The text log is append-only and date-rolled per UTC day; it includes skipped-signal
   reasons.
6. Live 5m signals are still identical to the 5m backtest (shared `FIVE_MIN_TUNING`).
7. `bun run check` passes. No change to `packages/core` strategy logic.
8. A logging failure logs an error but does not stop trading.

---

## 7. Running change log (newest first)

> Format: `### YYYY-MM-DD — short title` then a couple of bullets.

### 2026-06-10 — Branch spec created
- Created this file as the single doc for the `paper-5min-only` branch.
- Defined scope (5m only, PAPER or TESTNET run separately), the full trade-log requirements
  (JSONL with size/entry/stop/fees/indicators/account context + date-rolled text log + DB),
  and acceptance criteria. Handed to Codex; not yet implemented.

<!-- Add your next entry above this line -->
