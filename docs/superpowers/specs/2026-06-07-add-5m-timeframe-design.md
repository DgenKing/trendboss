# Add 5m Trade Timeframe — Design Spec

**Date:** 2026-06-07
**Author:** DgenKing (via Claude)
**Branch:** (create) `add-5m-timeframe`
**Status:** Approved for implementation by Codex

---

## Objective

Add **`5m`** as a selectable trade timeframe alongside the existing
`15m` / `1h` / `2h` / `4h`, so it can be backtested, run in the portfolio simulator,
and selected in the dashboard — exactly like the other timeframes.

This is purely **additive**: it extends the switchable-timeframe system that already
exists. No existing timeframe changes.

## NON-NEGOTIABLE CONSTRAINT — do not break what works

- `15m`, `1h`, `2h`, `4h` blocks and behaviour **MUST stay byte-identical**. Output for
  those four must be unchanged after this work.
- 5m is added as a **new** entry everywhere the other intervals are listed.
- The 5m **tuning block starts as an exact copy of the `15m` block** — this task does NOT
  tune 5m. Tuning is a later, separate task.

## Known limitation — record it honestly (this is important)

Hyperliquid serves ~5,000 candles per timeframe. At 5m that is only **~17 days** of
history. That means:

- 5m backtests cover a very short window with a small number of trades.
- Results will be **statistically weak** and must not be treated as robust.
- Trading costs (3.5 bps + 1.5 bps per side) weigh much more heavily on a fast timeframe.

5m is being added for **observation / experimentation**, not because it is expected to be a
reliable edge. The UI and any logged results should make the short-history caveat visible
(e.g. show the active history depth like the other timeframes already do).

## Config changes (`config.ts`)

1. `tradeIntervals` → add `'5m'`: `['5m', '15m', '1h', '2h', '4h']`.
2. `regimeForTrade` → add a mapping for `'5m'`. **Use `'5m': '1h'`** (a stable higher
   timeframe with deep history for regime classification), keeping the existing four
   mappings unchanged.
3. `chartIntervals` → add `'5m'`: `['5m', '15m', '1h', '2h', '4h', '1d']`.
4. `backfillTarget` → add `'5m': 5000`.
5. `config.tuning` → add a **`'5m'` block that is an exact copy of the `'15m'` block**, with
   a clear `// ===== 5m tuning =====` header. Do not change any values.
6. `assertValidConfig()` already validates that each trade interval has a regime mapping and
   that intervals appear in `chartIntervals` / `backfillTarget`. Confirm 5m passes all of
   these checks (it will once the four lists above include it).

`tuningFor('5m')` must return the new block (it will automatically, since it reads
`config.tuning[interval]`).

## Data backfill (`packages/monitor`)

- Ensure the monitor backfills and caches `5m` candles the same way it does the other
  intervals (it iterates the configured intervals / `backfillTarget`, so adding `5m` to the
  config should be enough — verify the backfill loop actually pulls 5m).
- No pagination changes; 5m simply backfills its most recent ~5,000 candles (~17 days).

## API (`packages/monitor/api.ts`)

- The portfolio and backtest endpoints already validate `interval` against
  `config.tradeIntervals` and cache per interval, so `5m` is accepted automatically once
  it is in `tradeIntervals`. Confirm `?interval=5m` works and is cached separately.

## Dashboard (`packages/web`)

- The trade-timeframe switcher must include **`5m`** as the first option
  (`5m | 15m | 1h | 2h | 4h`).
- Selecting `5m` refetches the backtest/portfolio for `5m` and shows its active history
  depth (~17 days) next to the results, like the other timeframes.
- The per-symbol chart timeframe buttons are separate and unrelated — leave them as-is.

## Validation (acceptance criteria)

1. `15m` / `1h` / `2h` / `4h` output is unchanged (the gate).
2. `5m` runs end-to-end: backfill → backtest → portfolio → dashboard.
3. `5m` tuning block is an exact copy of `15m`; no other block changed.
4. `?interval=5m` is accepted by the API and cached separately.
5. Dashboard switcher offers `5m` and shows its (short) history depth.
6. `bun run check` is clean.

## Out of scope (do NOT do in this task)

- Tuning the 5m parameters (separate task, later).
- Adding 1m or 3m (deliberately skipped — too little history, too much fee drag).
- Any change to the other timeframes' values.
- Any live order placement.
