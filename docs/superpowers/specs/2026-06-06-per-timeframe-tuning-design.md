# Per-Timeframe Parameter Tuning — Design Spec

**Date:** 2026-06-06
**Author:** DgenKing (via Claude)
**Branch:** `tune-settings`
**Status:** Approved for implementation by Codex

---

## Objective

Give each trade timeframe (`15m`, `1h`, `2h`, `4h`) its **own block of tunable
strategy parameters**, so the higher timeframes can be tuned independently instead
of all sharing one global set of numbers.

Today every timeframe uses the SAME global knobs in `config.ts`. A `40`-candle
breakout lookback means ~10 hours on `15m` but ~160 hours on `4h`, so one-size
settings cannot be right for all of them. This change makes the settings
**per-interval** so each can be dialled in separately.

## NON-NEGOTIABLE CONSTRAINT — do not break what works

`15m` is the proven, working configuration.

- The `15m` tuning block **MUST keep the exact current values** (see table below).
- With `15m` selected, the strategy, backtest, and portfolio simulator **MUST
  produce identical output to today** — same trades, same numbers. This is the
  acceptance gate; verify against a saved before-snapshot.
- `1h` / `2h` / `4h` blocks start as **identical copies** of the 15m values, so
  behaviour is unchanged on day one. They exist so the user can tune them next;
  this task only creates the blocks and wires them through, it does NOT pick new
  numbers for them.

If any 15m result changes, the implementation is wrong. Stop and fix.

## What is being made per-interval

These are the fields currently global on `config` that must move into a per-interval
block. (Confirmed by grep: they are only consumed in `packages/monitor/api.ts` and
`packages/monitor/index.ts`.)

| Field | Current value (becomes the 15m baseline) |
|---|---|
| `swingLookbackDays` | `0` |
| `pivotWindow` | `2` |
| `swingMinDistancePct` | `0.015` |
| `touchTolerance` | `0.0008` |
| `touchCooldownMinutes` | `60` |
| `confirmWithinCandles` | `3` |
| `stopBuffer` | `0.0005` |
| `regime` | `{ adxPeriod: 14, adxThreshold: 22, fastEmaPeriod: 20, slowEmaPeriod: 50, slowEmaSlopeLookback: 10 }` |
| `trend` | `{ breakoutLookback: 40, atrPeriod: 14, atrStopMultiple: 2.5, targetR: 2.5, rsiPeriod: 14, rsiLongMin: 60, rsiShortMax: 40 }` |
| `range` | `{ enabled: true, maxAdx: 12, targetR: 2, minScore: 80 }` |

**Not moved (stay global):** `coins`, `tradeInterval(s)`, `regimeForTrade`,
`candleInterval`, `regimeInterval`, `chartIntervals`, `backfillTarget`,
`backfill*`, `backtest` (fees/slippage), `portfolio`, `staleSocketSeconds`,
`apiPort`, `pollMs`, `dbPath`, `telegram`, `restUrl`, `wsUrl`. Fees, slippage,
risk sizing, and margin caps are NOT per-interval.

## Config changes (`config.ts`)

1. Add a type for one block:

```ts
export type IntervalTuning = {
  swingLookbackDays: number;
  pivotWindow: number;
  swingMinDistancePct: number;
  touchTolerance: number;
  touchCooldownMinutes: number;
  confirmWithinCandles: number;
  stopBuffer: number;
  regime: { adxPeriod: number; adxThreshold: number; fastEmaPeriod: number; slowEmaPeriod: number; slowEmaSlopeLookback: number };
  trend: { breakoutLookback: number; atrPeriod: number; atrStopMultiple: number; targetR: number; rsiPeriod: number; rsiLongMin: number; rsiShortMax: number };
  range: { enabled: boolean; maxAdx: number; targetR: number; minScore: number };
};
```

2. Add a `tuning` map on `config`, keyed by `TradeInterval`, with **four explicit,
   fully-written-out blocks** (do NOT use spreads/copies — write each block as its
   own literal so the user can edit any one independently and see it clearly):

```ts
tuning: {
  '15m': { /* EXACT current values — the baseline, do not change */ },
  '1h':  { /* identical to 15m for now — tune later */ },
  '2h':  { /* identical to 15m for now — tune later */ },
  '4h':  { /* identical to 15m for now — tune later */ },
} as Record<TradeInterval, IntervalTuning>,
```

   Put a clear comment header on each block (e.g. `// ===== 1h tuning =====`) so the
   blocks are obvious to edit.

3. Add a helper:

```ts
export function tuningFor(interval: TradeInterval): IntervalTuning {
  return config.tuning[interval];
}
```

4. Remove the now-moved global fields from `config` (they live only inside `tuning`
   now) — OR, if simpler and less risky, keep the old top-level fields as aliases of
   `tuning['15m']` so nothing unexpected breaks. Either is acceptable as long as the
   two consumers below read per-interval and 15m output is identical.

## Consumer changes

### `packages/monitor/api.ts`
- `buildPortfolio(...)` and `buildBacktest(...)` already receive `tradeInterval`.
  At the top of each, do `const t = tuningFor(tradeInterval);` and replace every
  `config.touchTolerance`, `config.touchCooldownMinutes`, `config.confirmWithinCandles`,
  `config.stopBuffer`, `config.range`, `config.trend`, `config.regime`,
  `config.swingLookbackDays`, `config.pivotWindow`, `config.swingMinDistancePct`
  with the `t.*` equivalent.
- This is the whole point: each interval's backtest/portfolio now uses its own block.

### `packages/monitor/index.ts`
- The live monitor runs on the single active `config.tradeInterval`. At the top of
  the relevant functions do `const t = tuningFor(config.tradeInterval);` and swap the
  same fields (`computeAndStoreLevels` uses the swing params; `handleClosedCandle`
  uses detection/rangeSignal/range/trend; the regime indicator call uses `t.regime`).

## Validation (acceptance criteria)

1. **15m unchanged (the gate):** capture backtest + portfolio output for `15m`
   BEFORE the change; after the change, default `15m` output is byte-identical.
2. `1h` / `2h` / `4h` still run end-to-end and (since their blocks are copies for now)
   return the same results they do today — proving the wiring is correct without
   changing behaviour yet.
3. `tuningFor()` returns the right block per interval.
4. `bun run check` (tests + tsc) is clean.
5. The four tuning blocks are written out explicitly and are easy to find and edit.

## Out of scope (do NOT do in this task)

- Actually choosing new numbers for `1h` / `2h` / `4h`. That is the user's next step
  once the blocks exist.
- Making fees, slippage, risk sizing, or margin caps per-interval.
- Any dashboard UI for editing tuning.
- Any change to live order placement (there is none).
