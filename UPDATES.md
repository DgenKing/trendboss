# UPDATES

A plain-English log of what's changed on this project, so anyone picking it up can
see at a glance what's been done and why — without reading every commit.

**Branch:** `benclawbot-version`
**Compared against:** the original `master` branch.

---

## 1. What the original app was (`master`)

A **monitoring / alerting tool** for Hyperliquid perps — *not* a trading bot.

- Auto-marks 4 price levels per coin (range high/low + nearest swing high/low).
- Watches live 15m candles and fires Telegram alerts when price touches a level.
- Produces informational "reversion" signals (entry/stop/target/score) — surfaced, never traded.
- Read-only web dashboard: candlestick chart + level lines + signal feed.
- No strategy, no backtesting, no orders. (The README literally lists backtesting as out of scope.)

## 2. What's already changed on this branch

Three layers were added on top of the original monitor (commits `60d9bdf`, `adc68a7`, `e6b52d1`):

### a) Regime-aware strategy engine
- Classifies every coin as **UPTREND / DOWNTREND / RANGE** from 1h candles
  (using EMA 20/50, ADX, RSI, ATR).
- Runs **TREND_MOMENTUM** (breakout in the trend's direction) only in trends.
- Runs **RANGE_REVERSION** (fade the edges) only in ranges.
- One active trade per coin. Every trade has an entry, stop, and target.
- Same logic is used for both live monitoring and backtesting.
- New files: `packages/core/strategy.ts`, `packages/core/indicators.ts`.

### b) Backtester
- Replays historical candles through the strategy to show how it *would* have done.
- **Includes fees + slippage** (3.5 bps + 1.5 bps per side).
- Splits results into in-sample / out-of-sample.
- New file: `packages/core/backtest.ts`.

### c) Shared-capital portfolio simulator
- Simulates ONE $1,000 account (5x leverage) where all coins compete for the same capital,
  instead of misleadingly summing separate per-coin backtests.
- Risk 2% per trade; margin caps per position (25%) and total (100%).
- Highest-scoring signal gets capital first; signals are rejected when margin is exhausted.
- Powers the new **Portfolio** tab on the dashboard.
- New files: `packages/core/portfolio.ts`, `packages/web/components/PortfolioView.tsx`,
  `packages/web/components/PortfolioChart.tsx`, new `GET /api/portfolio` endpoint.

### Known facts / limits discovered
- **Hyperliquid only retains ~52 days of 15m candles** (history dead-ends ~2026-04-15).
  Older 15m data cannot be downloaded — it doesn't exist on the API.
- 1h history reaches ~211 days; 4h ~836 days; 1d back to 2020.
- All backtest/portfolio numbers are **historical simulation only** — not live, not real money.

---

## 3. Running change log (newest first)

> Add an entry every time you change something. Keep it short: what + why.
> Format: `### YYYY-MM-DD — short title` then a couple of bullet points.

### 2026-06-06 — Implemented per-timeframe tuning blocks
- Added `IntervalTuning`, explicit `15m`/`1h`/`2h`/`4h` tuning blocks, and `tuningFor(interval)` in
  `config.ts`; the `15m` values are the prior globals, and the other intervals are identical copies for now.
- Rewired monitor backtest/portfolio API builders and live candle evaluation to read swing, detection,
  regime, trend, and range settings from the selected interval's tuning block.
- Saved the all-interval Step 0 baseline at `docs/superpowers/baselines/2026-06-06-tuning-baseline.json`;
  after implementation, regenerated output for all four intervals diffed byte-identical against it.
- Verified `bun run check` is clean.

### 2026-06-06 — Implemented switchable trading timeframe
- Added `TRADE_INTERVAL` / `tradeInterval` support for `15m`, `1h`, `2h`, and `4h`, with regime mapping
  `15m→1h`, `1h→4h`, `2h→4h`, `4h→1d`; default `15m` remains unchanged.
- Added `2h` candle backfill/cache support and backfilled the local monitor database for the configured markets.
- Portfolio and backtest APIs now accept `?interval=...`, reject invalid trade intervals, cache results per interval,
  and label results with their trade/regime intervals.
- Dashboard Portfolio and Strategy Backtest views now have a trade-timeframe switcher and show active history depth
  while keeping symbol chart timeframe buttons separate.
- Saved the Step 0 baseline at `docs/superpowers/baselines/2026-06-06-15m-baseline.json`; after implementation,
  the pinned default `15m` backtest/portfolio output diffed identical against it.

### 2026-06-06 — Created this file
- Added `UPDATES.md` to track changes from here on.

### 2026-06-06 — Spec'd switchable trading timeframe (15m/1h/2h/4h) for Codex
- **Decision:** make the strategy's trade timeframe switchable instead of hard-wired to 15m.
  Reason: higher timeframes have far deeper Hyperliquid history, so backtests can cover real
  bull/bear/range cycles instead of only ~52 days.
- **Verified data depth (Hyperliquid, 2026-06-06):** 15m ~52d · 1h ~208d · 2h ~417d · 4h ~833d (~2.3yr).
- **Hard rule recorded:** default stays **15m** and must produce identical output (proven vs a
  saved baseline) — the feature is additive/opt-in so the working setup can't break.
- **Regime mapping decided:** trade 15m→regime 1h (unchanged), 1h→4h, 2h→4h, 4h→1d.
- **Not building (out of scope):** per-timeframe param re-tuning, 15m backwards-pagination
  (data doesn't exist on Hyperliquid), non-Hyperliquid data sources, any live order placement.
- **Wrote for Codex to implement:**
  - Spec: `docs/superpowers/specs/2026-06-06-switchable-trading-timeframe-design.md`
  - Plan: `docs/superpowers/plans/2026-06-06-switchable-trading-timeframe.md`
- **Status:** spec + plan written; implementation NOT started yet.

### 2026-06-06 — Rebranded display name to TrendBoss
- Renamed the user-facing name from **RangeBoss** to **TrendBoss** — the strategy is really a
  trend-momentum system, not a range trader, so the old name was misleading.
- Updated logo image (`packages/web/public/rangeboss-logo.png`) and the display name in
  `packages/web/app/page.tsx` (logo alt) + `packages/web/app/layout.tsx` (tab title).
- Left the repo name, folder names, and the logo's filename unchanged on purpose (avoids breaking
  clone URLs and `$$`-in-path issues). Brand = TrendBo$$ visually; code/repo stays clean.

### 2026-06-06 — Completed full rename RangeBoss → TrendBoss / TrendBo$$
- Brand/display name is **TrendBo$$** (with the `$$`); all code, files, and folders use the
  shell-safe **trendboss** (no `$$`) to avoid breakage in shells, URLs, and paths.
- Renamed logo file `rangeboss-logo.png` → `trendboss-logo.png` and updated its `<img src>`.
- Renamed localStorage theme key `rb-theme` → `tb-theme` (note: this resets any saved theme
  to default once, harmless).
- README title now `# TrendBo$$ — Hyperliquid Trend Monitor`.
- Logo alt text + browser tab title set to `TrendBoss`.
- Verified `bunx tsc --noEmit` passes; no `rangeboss`/`rb-theme` refs remain except in this log's history.
- STILL TO DO BY USER (not code): rename the GitHub repo + local folder from `rangeboss` to
  `trendboss` if desired — that's a git/GitHub action (would change the clone URL and require
  BenClawBot to update his remote). Internal package names are `hl-level-monitor` and were left as-is.

### 2026-06-06 — Spec'd per-timeframe parameter tuning for Codex
- **Decision:** give each trade timeframe (`15m`/`1h`/`2h`/`4h`) its own block of tunable
  strategy params, instead of all four sharing one global set. This is the follow-up task that
  the switchable-timeframe spec explicitly deferred as "separate, must-be-approved" — now approved.
- **Reason:** candle-based params (e.g. 40-candle breakout lookback) mean very different wall-clock
  windows per timeframe (~10h on 15m vs ~160h on 4h), so one global setting can't suit all.
- **Hard rule recorded:** `15m` block keeps the EXACT current values and must produce identical
  output; `1h`/`2h`/`4h` blocks start as identical copies — this task is WIRING ONLY, no new numbers.
- **Fields moving per-interval:** swingLookbackDays, pivotWindow, swingMinDistancePct, touchTolerance,
  touchCooldownMinutes, confirmWithinCandles, stopBuffer, regime{}, trend{}, range{}.
- **Staying global:** fees/slippage, risk sizing, margin caps, coins, intervals/backfill, infra.
- **Consumers to rewire:** `packages/monitor/api.ts` (`buildPortfolio`, `buildBacktest`) and
  `packages/monitor/index.ts` (`computeAndStoreLevels`, `handleClosedCandle`) via a new
  `tuningFor(interval)` helper in `config.ts`.
- **Wrote for Codex to implement:**
  - Spec: `docs/superpowers/specs/2026-06-06-per-timeframe-tuning-design.md`
  - Plan: `docs/superpowers/plans/2026-06-06-per-timeframe-tuning.md`
- **Status:** spec + plan written; implementation NOT started yet. New branch `tune-settings`.

### 2026-06-06 — Rewrote README for the current (TrendBoss) engine
- The README still described the old RangeBoss **monitor-only** app (backtesting listed as
  "out of scope"). Rewrote it from a full read of `packages/core` to describe what the app
  actually is now: a regime-aware strategy + backtester + shared-capital portfolio simulator,
  plus the original live monitor/dashboard/Telegram alerts.
- Added plain-English "How it works" sections explaining: level computation (`levels.ts`),
  regime detection via EMA/ADX/RSI (`indicators.ts`), trade detection for TREND_MOMENTUM and
  RANGE_REVERSION (`strategy.ts` + `detect.ts`), the backtester with fees/slippage
  (`backtest.ts`), and the shared-capital portfolio simulator (`portfolio.ts`).
- Documented the switchable trade timeframe + data-depth table, refreshed the config table,
  API endpoints (incl. `/api/backtest`, `/api/portfolio`, `/api/trade-intervals`), and scope.
- Title is now `# TrendBo$$ — Hyperliquid Regime Strategy & Monitor`; kept the animated banner.
- Docs-only change; no code touched.

<!-- Add your next entry above this line -->
