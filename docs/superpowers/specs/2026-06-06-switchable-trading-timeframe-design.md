# Switchable Trading Timeframe — Design Spec

**Date:** 2026-06-06
**Author:** DgenKing (via Claude)
**Branch:** `benclawbot-version`
**Status:** Approved for implementation by Codex

---

## Objective

Let the regime-aware strategy run on a **selectable trade timeframe** — `15m`, `1h`,
`2h`, or `4h` — instead of being hard-wired to `15m`.

The point: higher timeframes have far deeper Hyperliquid history, so the backtest can
cover real bull/bear/range cycles instead of only ~52 days.

**Verified data depth on Hyperliquid (2026-06-06):**

| Trade timeframe | Candles available | History depth |
|---|---|---|
| `15m` | ~5000 | ~52 days |
| `1h`  | ~5000 | ~208 days |
| `2h`  | ~5000 | ~417 days |
| `4h`  | ~5000 | ~833 days (~2.3 years) |

## NON-NEGOTIABLE CONSTRAINT — do not break what works

`15m` is the proven, working configuration. After this change:

- The default trade timeframe **MUST remain `15m`**.
- With the default selected, the strategy, backtest, and portfolio simulator **MUST
  produce identical output to today** (same trades, same numbers). This is the
  acceptance gate — verify it with a saved before/after snapshot.
- The switchable timeframe is **additive and opt-in**. Nothing existing is removed.

If any 15m result changes, the implementation is wrong. Stop and fix.

## Concepts: two intervals, kept distinct

The engine already uses two separate intervals — keep this separation:

1. **Trade interval** — the candles the strategy makes entry/exit decisions on.
   Today this is `config.candleInterval = '15m'`. This is the thing becoming switchable.
2. **Regime interval** — the higher timeframe used only to classify UPTREND/DOWNTREND/RANGE.
   Today this is `config.regimeInterval = '1h'`.

The relationship must stay "**decide direction on a higher timeframe, act on a lower one**."
So the regime interval scales with the trade interval per the mapping below.

## Config changes (`config.ts`)

Add a single source of truth for the selected trade timeframe and a regime mapping.

```ts
// NEW: the selectable trade timeframe. Env override: TRADE_INTERVAL.
tradeInterval: (process.env.TRADE_INTERVAL ?? '15m') as TradeInterval,

// NEW: allowed trade timeframes.
tradeIntervals: ['15m', '1h', '2h', '4h'] as const,

// NEW: which regime (higher) timeframe each trade timeframe uses.
regimeForTrade: {
  '15m': '1h',
  '1h':  '4h',
  '2h':  '4h',
  '4h':  '1d',
} as Record<TradeInterval, string>,
```

Derive the active intervals from `tradeInterval`:

- `candleInterval` (existing field) = `tradeInterval` (keep the old name working as an alias so
  nothing downstream breaks; default `'15m'` → unchanged).
- `regimeInterval` (existing field) = `config.regimeForTrade[tradeInterval]` (default `'1h'` → unchanged).

`chartIntervals` and `backfillTarget` must include **every** timeframe any mode can need:
`['15m', '1h', '2h', '4h', '1d']`. (Add `2h`; it is currently missing — confirmed supported by
Hyperliquid on 2026-06-06.)

Update `assertValidConfig()` to:

- reject a `tradeInterval` not in `tradeIntervals`;
- reject if `tradeInterval` or its mapped `regimeInterval` is not in `chartIntervals`;
- keep the existing backfill-target validation.

## Strategy parameters — keep them constant by default

`config.trend` / `config.range` (breakoutLookback 40, atrStopMultiple 2.5, ADX thresholds, etc.)
are expressed **in candles**, not wall-clock time. Do NOT auto-rescale them per timeframe in this
change. Keep the same candle-based parameters for every trade timeframe so behaviour is
predictable and the 15m path is provably unchanged.

> Note for later (out of scope here): the same 40-candle lookback means ~10 hours on 15m but
> ~160 hours on 4h. Per-timeframe parameter tuning may be wanted eventually, but that is a
> SEPARATE, explicitly-approved task — not part of this one.

## Data backfill (`packages/monitor`)

- Add `2h` to the backfill loop and `backfillTarget` so 2h candles get cached like the others.
- No backwards-pagination is added (Hyperliquid does not serve older 15m — confirmed
  2026-06-06). Each timeframe simply backfills its most recent ~5000 candles.

## Backtest & portfolio (`packages/core`)

- The backtest and portfolio simulator must read the **trade interval's** candles and the
  **mapped regime interval's** candles, both derived from `config.tradeInterval`.
- The backtest/portfolio window therefore auto-adjusts to whatever depth the selected
  timeframe has (e.g. 4h → ~833 days). No window code changes beyond reading the configured
  intervals.
- Fees/slippage, risk sizing, margin caps, and priority rules are **unchanged**.
- The result objects should record which `tradeInterval` and `regimeInterval` produced them,
  so the dashboard and any saved output are self-describing.

## API (`packages/monitor/api.ts`)

- `GET /api/portfolio` and the backtest endpoint accept an optional `interval` query param
  (one of the allowed trade timeframes). If omitted, use `config.tradeInterval`.
- Validate the param against `tradeIntervals`; reject unknown values with 400.
- Cache results **per interval** (the existing single cache must become keyed by interval so
  switching does not serve a stale other-timeframe result).

## Dashboard (`packages/web`)

- Add a **trade-timeframe switcher** (`15m | 1h | 2h | 4h`) near the Portfolio/backtest UI.
- Selecting a timeframe re-requests the portfolio/backtest for that interval and re-renders.
- Show the active timeframe and its **history depth** (e.g. "4h · ~833 days") next to results so
  the user always knows which window they are looking at.
- Default selection is `15m`.
- The existing per-symbol chart timeframe buttons are unrelated to this and stay as-is.

## Validation (acceptance criteria)

1. **15m unchanged (the gate):** capture backtest + portfolio output on `master`/current 15m
   BEFORE the change; after the change with default `15m`, output is identical.
2. Switching to `1h` / `2h` / `4h` runs end-to-end and returns a longer-dated result matching
   the depths in the table above.
3. `2h` candles backfill and cache correctly.
4. Invalid `tradeInterval` / `interval` param is rejected by config validation / the API.
5. API caches per interval — rapid switching never serves the wrong timeframe's data.
6. Unit tests cover: regime-interval mapping, config validation of the new fields, and
   per-interval cache keying.
7. Dashboard switcher works on desktop and mobile; active timeframe + depth are visible.
8. Results remain labelled **historical simulation only** — no implication of future profit.

## Out of scope (do NOT do in this task)

- Per-timeframe parameter tuning / re-optimisation.
- Backwards-pagination of 15m history (data does not exist on Hyperliquid).
- Pulling data from any non-Hyperliquid exchange.
- Any change to live order placement (there is none; this stays a simulator/monitor).
