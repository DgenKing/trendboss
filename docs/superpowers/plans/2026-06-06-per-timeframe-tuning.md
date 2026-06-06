# Per-Timeframe Parameter Tuning — Implementation Plan

**Date:** 2026-06-06
**Spec:** `docs/superpowers/specs/2026-06-06-per-timeframe-tuning-design.md`
**Branch:** `tune-settings`
**For:** Codex

Read the spec first. The hard rule: **the default `15m` path must produce identical
output after this change.** The `1h`/`2h`/`4h` blocks are copies of 15m for now, so
ALL intervals should still produce today's results — this task is wiring only, not
re-tuning. Capture a before-snapshot and diff it at the end.

---

## Step 0 — Safety snapshot (do this BEFORE editing)

- Run the existing backtest and portfolio for `15m`, `1h`, `2h`, `4h` and save the
  output to `docs/superpowers/baselines/2026-06-06-tuning-baseline.json`.
- All four must still match this after the change (blocks are copies for now).

## Step 1 — Config (`config.ts`)

- Add the `IntervalTuning` type (spec §Config changes).
- Add a `tuning` map with **four explicit, fully-written-out blocks** keyed by
  `'15m' | '1h' | '2h' | '4h'`, each with a comment header.
  - `'15m'` = the EXACT current global values (the baseline table in the spec).
  - `'1h'`, `'2h'`, `'4h'` = identical copies of those values for now.
- Add `export function tuningFor(interval: TradeInterval): IntervalTuning`.
- Remove the moved global fields (or keep them as aliases of `tuning['15m']` if that
  is lower-risk). Whatever keeps 15m identical and tsc clean.

## Step 2 — API consumers (`packages/monitor/api.ts`)

- In `buildPortfolio` and `buildBacktest`, add `const t = tuningFor(tradeInterval);`
  and replace every moved `config.*` reference with the `t.*` equivalent
  (touchTolerance, touchCooldownMinutes, confirmWithinCandles, stopBuffer, range,
  trend, regime, swingLookbackDays, pivotWindow, swingMinDistancePct).

## Step 3 — Live monitor (`packages/monitor/index.ts`)

- Add `const t = tuningFor(config.tradeInterval);` in `computeAndStoreLevels` and
  `handleClosedCandle` and swap the same fields (swing params; detection;
  rangeSignal; range/trend; `calculateIndicatorSeries(..., t.regime)`).

## Step 4 — Verify & log

- `bun run check` (tests + tsc). Do NOT run `bun run build` while a dev server is up.
- Re-run backtest/portfolio for all four intervals; **diff against Step 0 baseline —
  all four must be identical** (copies for now).
- Add a dated entry to `UPDATES.md` describing exactly what changed.

---

## Definition of done

- [ ] `config.tuning` has four explicit, clearly-labelled, independently-editable blocks.
- [ ] `15m` block holds the exact prior values; `1h`/`2h`/`4h` are copies for now.
- [ ] `tuningFor()` added and used by both consumers.
- [ ] All four intervals' output identical to Step 0 baseline.
- [ ] `bun run check` clean.
- [ ] `UPDATES.md` updated with a dated entry.
- [ ] NO new numbers chosen for 1h/2h/4h — that's the user's next step.
