# Add 5m Trade Timeframe — Implementation Plan

**Date:** 2026-06-07
**Spec:** `docs/superpowers/specs/2026-06-07-add-5m-timeframe-design.md`
**Branch:** (create) `add-5m-timeframe`
**For:** Codex

Read the spec first. This is additive: add `5m` everywhere the other intervals are listed,
copy the 15m tuning block as the starting 5m block, and DO NOT change 15m/1h/2h/4h.

---

## Step 0 — Safety snapshot (before editing)

- Capture current backtest + portfolio output for `15m`, `1h`, `2h`, `4h`. These must stay
  identical after the change.

## Step 1 — Config (`config.ts`)

- Add `'5m'` to `tradeIntervals` (put it first): `['5m','15m','1h','2h','4h']`.
- Add `'5m': '1h'` to `regimeForTrade`.
- Add `'5m'` to `chartIntervals` and `'5m': 5000` to `backfillTarget`.
- Add a `'5m'` block to `config.tuning` that is an EXACT copy of the `'15m'` block, with a
  `// ===== 5m tuning =====` header.
- Confirm `assertValidConfig()` passes for 5m.

## Step 2 — Backfill (`packages/monitor`)

- Verify the monitor backfills/caches `5m` candles like the other intervals. If the loop is
  driven by config, adding 5m above is enough — confirm by running the monitor and seeing 5m
  candles cached.

## Step 3 — API (`packages/monitor/api.ts`)

- Confirm `?interval=5m` is accepted on the backtest + portfolio endpoints and cached
  separately (it should be automatic via `config.tradeIntervals`).

## Step 4 — Dashboard (`packages/web`)

- Add `5m` to the trade-timeframe switcher (first option).
- On selecting 5m, refetch and show its active history depth (~17 days).

## Step 5 — Verify & log

- `bun run check` (tests + tsc). Do NOT run `bun run build` while a dev server is up.
- Re-run 15m/1h/2h/4h and diff against Step 0 — must be identical.
- Run 5m once; confirm it returns a (short-window) result end-to-end.
- Add a dated entry to `UPDATES.md` describing what changed, INCLUDING the ~17-day history
  caveat for 5m.

---

## Definition of done

- [ ] `5m` selectable everywhere (config, API, dashboard).
- [ ] 5m tuning block is an exact copy of 15m; 15m/1h/2h/4h untouched and identical output.
- [ ] 5m backfills, backtests, and runs in the portfolio.
- [ ] Dashboard switcher shows 5m + its history depth.
- [ ] `bun run check` clean.
- [ ] `UPDATES.md` updated, with the short-history caveat noted.
- [ ] 5m NOT tuned (left as a 15m copy) — tuning is a separate later task.
