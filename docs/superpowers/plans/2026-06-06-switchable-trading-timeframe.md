# Switchable Trading Timeframe — Implementation Plan

**Date:** 2026-06-06
**Spec:** `docs/superpowers/specs/2026-06-06-switchable-trading-timeframe-design.md`
**Branch:** `benclawbot-version`
**For:** Codex

Read the spec first. The hard rule: **the default `15m` path must produce identical
output after this change.** Capture a before-snapshot and diff it at the end.

---

## Step 0 — Safety snapshot (do this BEFORE editing)

- Run the existing 15m backtest and portfolio simulation; save the JSON/output to
  `docs/superpowers/baselines/2026-06-06-15m-baseline.json`.
- This is the reference the final 15m result must match exactly.

## Step 1 — Config (`config.ts`)

- Add `tradeInterval` (default `'15m'`, env `TRADE_INTERVAL`).
- Add `tradeIntervals = ['15m','1h','2h','4h']`.
- Add `regimeForTrade` mapping: `15m→1h`, `1h→4h`, `2h→4h`, `4h→1d`.
- Derive `candleInterval = tradeInterval` and `regimeInterval = regimeForTrade[tradeInterval]`.
- Add `2h` to `chartIntervals` and `backfillTarget` (target 5000).
- Extend `assertValidConfig()` per the spec (validate new fields).

## Step 2 — Data backfill (`packages/monitor/index.ts`)

- Ensure the backfill loop covers `2h` and writes it to the store like other intervals.
- No pagination changes.

## Step 3 — Core engine (`packages/core`)

- Make `backtest.ts` and `portfolio.ts` read intervals from config
  (`tradeInterval` + mapped `regimeInterval`) rather than assuming `15m`/`1h`.
- Keep all strategy params, fees, slippage, sizing, and rules unchanged.
- Stamp `tradeInterval` + `regimeInterval` onto result objects.

## Step 4 — API (`packages/monitor/api.ts`)

- Accept optional `interval` query param on portfolio + backtest endpoints; default to
  `config.tradeInterval`; validate against `tradeIntervals` (400 on bad value).
- Make the response cache **keyed by interval**.

## Step 5 — Dashboard (`packages/web`)

- Add a `15m | 1h | 2h | 4h` switcher near the Portfolio/backtest view.
- On change, refetch for that interval and re-render.
- Display active timeframe + history depth (e.g. "4h · ~833 days").
- Default `15m`.

## Step 6 — Tests (`packages/core/core.test.ts`)

- regime-interval mapping is correct for each trade timeframe;
- config validation rejects bad `tradeInterval`;
- per-interval cache keying.

## Step 7 — Verify & log

- `bun run check` (tests + tsc). Do NOT run `bun run build` while dev server is up.
- Re-run 15m backtest/portfolio; **diff against Step 0 baseline — must be identical.**
- Run `1h`, `2h`, `4h` once each; confirm longer windows return.
- Add a dated entry to `UPDATES.md` describing exactly what changed.

---

## Definition of done

- [ ] Default `15m` output identical to Step 0 baseline.
- [ ] `1h` / `2h` / `4h` all run and return their expected deeper windows.
- [ ] `2h` data backfills and caches.
- [ ] Bad interval rejected (config + API).
- [ ] Cache keyed per interval.
- [ ] Tests pass; `bun run check` clean.
- [ ] Dashboard switcher works, shows active timeframe + depth.
- [ ] `UPDATES.md` updated with a dated entry.
