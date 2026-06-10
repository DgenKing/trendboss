# Live Trader Tuning Must Match the 5m Backtest — Design Spec

**Date:** 2026-06-10
**Author:** DgenKing (via Claude)
**Branch:** `paper-trade`
**Status:** Approved for implementation by Codex

---

## Objective

Make the live paper/testnet trader use **the exact same strategy settings as the 5m
backtest**, so that "paper trades the backtested strategy" is true. Right now it does
**not** — the live loop reads a separate, hand-tuned `LIVE_TRADER_TUNING` block that has
drifted away from `config.tuning['5m']`. The live block is looser and more aggressive and
is losing money; the 5m backtest block is the validated, profitable one.

This restores the original approved design (the `2026-06-07-paper-and-testnet-trading`
spec, constraint #4: *"5m only. Use the tuned 5m block from `config.tuning['5m']`."*).

## NON-NEGOTIABLE CONSTRAINTS

1. **Do not change the strategy engine, backtest, portfolio, sizing, executor, feed, or
   dashboard logic.** This is a configuration-wiring change only. `packages/core` and
   `packages/trader/*.ts` behaviour must be untouched except for which tuning object the
   live trader reads.
2. **Do not change any value in the `5m` tuning block.** The 5m backtest numbers must come
   out of `bun run check` / the Backtest tab exactly as they do today. The 5m block is the
   source of truth; the live trader bends to it, never the reverse.
3. **One source of truth.** After this change it must be **structurally impossible** for the
   live tuning and the 5m backtest tuning to diverge again. Achieve this by making both read
   the **same object**, not by copy-pasting matching values.
4. **5m only.** The trader already hard-fails if `tradeInterval !== '5m'`. Keep that.

## Root cause (verified 2026-06-10)

- The **5m backtest** path (`packages/monitor/api.ts` `buildBacktest`, line ~288) reads
  `tuningFor('5m')` → `config.tuning['5m']`.
- The **live trader** path (`packages/trader/index.ts` `liveTraderTuning`, line ~369) reads
  `config.trader.tuning`, which is set to the standalone `LIVE_TRADER_TUNING` constant
  (`config.ts` line ~52).
- Both paths feed the **same** `RegimeAwareStrategyEngine`, so the *logic* is identical, but
  the *parameters* differ on almost every field.

### Exact divergence (live `LIVE_TRADER_TUNING` vs `config.tuning['5m']`)

| Setting | 5m backtest (correct) | Live (wrong, to remove) |
|---|---|---|
| `touchTolerance` | 0.0006 | 0.0025 |
| `touchCooldownMinutes` | 60 | 10 |
| `confirmWithinCandles` | 3 | 8 |
| `regime.adxThreshold` | 38 | 18 |
| `trend.breakoutLookback` | 80 | 12 |
| `trend.atrStopMultiple` | 3.4 | 1.8 |
| `trend.targetR` | 2.2 | 1.2 |
| `trend.rsiLongMin` | 62 | 50 |
| `trend.rsiShortMax` | 38 | 50 |
| `range.maxAdx` | 16 | 30 |
| `range.targetR` | 2.4 | 1.2 |
| `range.minScore` | 80 | 40 |

(`swingLookbackDays`, `pivotWindow`, `swingMinDistancePct`, `stopBuffer`, all `regime` EMA
periods, `adxPeriod`, `atrPeriod`, `rsiPeriod` already match.)

## Required change

In `config.ts`:

1. Lift the inline `'5m'` tuning object out of the `config.tuning` literal into a single
   named `const FIVE_MIN_TUNING: IntervalTuning = { ... }` (the existing 5m values,
   unchanged).
2. Use `FIVE_MIN_TUNING` as the value of `config.tuning['5m']`.
3. Set `config.trader.tuning` to **the same** `FIVE_MIN_TUNING` reference.
4. **Delete** the `LIVE_TRADER_TUNING` constant entirely. It must not survive.

That is the whole change. There is an ordering detail: `config.trader.tuning` is inside the
`config` object literal, so it cannot reference `config.tuning['5m']` (self-reference). The
hoisted `FIVE_MIN_TUNING` const, declared above `config`, is what both sites reference.

## Out of scope (state explicitly, do not touch)

- Position sizing / allocation math (`packages/trader/sizing.ts`,
  `calculatePortfolioAllocation`). Live vs backtest execution realism (fills, fees,
  slippage) is a separate concern and is **not** part of this task.
- The other timeframe blocks (`15m`, `1h`, `2h`, `4h`). Leave them exactly as-is.

## Acceptance criteria

1. `LIVE_TRADER_TUNING` no longer exists anywhere in the codebase
   (`grep -r LIVE_TRADER_TUNING` returns nothing).
2. `config.trader.tuning === config.tuning['5m']` (same object reference).
3. `bun run check` passes and the 5m backtest output is **unchanged** from before this edit.
4. On live startup, the `[trader] live tuning override:` log prints the 5m values
   (`adxThreshold=38`, `rangeMaxAdx=16`, `rangeMinScore=80`, `touchTolerance=0.0006`,
   `confirmWithinCandles=3`, `breakoutLookback=80`, `rsiLongMin=62`, `rsiShortMax=38`,
   `targetR range=2.4 trend=2.2`).
5. No change to any non-5m timeframe.

## Expected behavioural effect (for the user, not a code requirement)

The live trader will become **less active** — wider qualifying touch, longer cooldown,
higher score threshold, harder trend filter. Fewer trades, but they will be the ones the 5m
backtest actually validated. This is the intended outcome.
