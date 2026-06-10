# Plan: Live Trader Tuning = 5m Backtest Block

**Spec:** `docs/superpowers/specs/2026-06-10-live-tuning-match-5m-backtest-design.md`
**Branch:** `paper-trade`
**For:** Codex

## Goal

Live paper/testnet trader must run the identical settings as the 5m backtest. Remove the
divergent `LIVE_TRADER_TUNING` block; make both the 5m backtest and the live trader read one
shared `FIVE_MIN_TUNING` object. Config-wiring only — no logic changes.

## Steps

1. **Hoist the 5m block.** In `config.ts`, above the `config` object, add:
   ```ts
   const FIVE_MIN_TUNING: IntervalTuning = { /* the current config.tuning['5m'] values, verbatim */ };
   ```
   Move the existing `'5m'` object's contents into it unchanged (swingLookbackDays 0,
   pivotWindow 2, swingMinDistancePct 0.015, touchTolerance 0.0006, touchCooldownMinutes 60,
   confirmWithinCandles 3, stopBuffer 0.0005, regime adxThreshold 38 etc., trend
   breakoutLookback 80 / atrStopMultiple 3.4 / targetR 2.2 / rsiLongMin 62 / rsiShortMax 38,
   range maxAdx 16 / targetR 2.4 / minScore 80).

2. **Point `tuning['5m']` at it.** In the `config.tuning` literal, replace the inline `'5m'`
   object with `'5m': FIVE_MIN_TUNING,`. Leave `15m`/`1h`/`2h`/`4h` untouched.

3. **Point the trader at it.** In `config.trader`, set `tuning: FIVE_MIN_TUNING,`.

4. **Delete `LIVE_TRADER_TUNING`.** Remove the whole constant (config.ts ~line 52–82).

5. **Verify.**
   - `grep -rn LIVE_TRADER_TUNING` → no matches.
   - `bun run check` passes.
   - Run/inspect the 5m backtest (Backtest tab or test) → numbers identical to pre-change.
   - Start the trader in PAPER → `[trader] live tuning override:` prints the 5m values
     listed in the spec's acceptance criteria.

## Risk / watch-outs

- TypeScript ordering: `FIVE_MIN_TUNING` must be declared **before** the `config` literal so
  both `tuning['5m']` and `trader.tuning` can reference it. (You cannot self-reference
  `config.tuning['5m']` from inside the `config` literal.)
- Do not "tidy" or re-round any 5m value while moving it. A single changed digit breaks
  acceptance criterion #3.
- This is the only intended behaviour change: the live trader will now trade much less
  often. That is expected and correct.

## Scope

`config.ts` only. No other file should change.
