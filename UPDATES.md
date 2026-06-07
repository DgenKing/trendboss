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

### 2026-06-07 — Tuned 2h with strict drawdown gates
- Tested 101 `2h` tuning combinations; 3 passed the portfolio/account hard gates, and the best survivor was
  `breakoutLookback=64`, `atrStopMultiple=3.1`, `targetR=2.2`, `rsiLongMin=68`,
  `rsiShortMax=32`, `range.maxAdx=8`, `range.targetR=1.4`, `range.minScore=75`.
  `touchTolerance=0.0008` and `adxThreshold=22` stayed unchanged.
- Shared 2h portfolio now passes the hard gates in all three windows:
  whole history return `135.26%`, PF `2.279`, max DD `17.74%`, win `51.22%`;
  older 70% return `31.34%`, PF `1.500`, max DD `17.74%`, win `44.90%`;
  recent 30% return `76.85%`, PF `3.511`, max DD `6.56%`, win `60.61%`.
- Diagnostic note: aggregate isolated backtests are profitable in all windows, but still show higher
  standalone R-drawdown (whole `28.22R`, older `22.48R`) than the shared account drawdown.
- Verified `bun run check` is clean and the `config.ts` diff touches only the `2h` tuning block.

### 2026-06-07 — Re-tuned 1h with strict drawdown gates
- Replaced the rejected high-recent-return 1h block with the only portfolio/account-level survivor from
  102 tested combinations: `touchTolerance=0.0006`, `adxThreshold=30`, `breakoutLookback=48`,
  `atrStopMultiple=2.8`, `targetR=3`, `rsiLongMin=65`, `rsiShortMax=35`,
  `range.maxAdx=16`, `range.targetR=2`, `range.minScore=85`.
- Shared 1h portfolio now passes the hard gates in all three windows:
  whole history return `57.12%`, PF `1.426`, max DD `17.28%`, win `32.58%`;
  older 70% return `12.33%`, PF `1.128`, max DD `17.28%`, win `27.59%`;
  recent 30% return `38.81%`, PF `1.919`, max DD `14.91%`, win `41.94%`.
- Diagnostic note: aggregate isolated backtests are still weaker than the shared account result
  (older 70% return `-16.17%`, PF `0.937`), so this is a stricter/account-safe 1h block,
  not proof that every standalone symbol backtest is healthy yet.
- Verified `bun run check` is clean and the `config.ts` diff touches only the `1h` tuning block.

### 2026-06-06 — Tuned the 1h parameter block
- Ran 100 deterministic 1h tuning iterations; 20 candidates improved out-of-sample return + profit factor
  without worsening out-of-sample drawdown.
- Kept the best 1h block found: `touchTolerance=0.0015`, `breakoutLookback=96`,
  `atrStopMultiple=3.4`, `targetR=4.2`, `rsiLongMin=58`, `rsiShortMax=42`,
  `range.maxAdx=10`, `range.targetR=3`, `range.minScore=85`; `adxThreshold` stayed `22`.
- Aggregate backtests: in-sample moved from return `-86.99%`, PF `0.873`, max DD `39.56R`,
  win `27.73%` to return `-96.35%`, PF `0.801`, max DD `45.84R`, win `16.67%`; out-of-sample
  improved from return `104.23%`, PF `1.134`, max DD `14.87R`, win `32.76%` to return
  `338.75%`, PF `2.145`, max DD `9.80R`, win `33.75%`.
- Shared portfolio: in-sample improved from return `-27.35%`, PF `0.702`, max DD `35.49%`,
  win `24.76%` to return `48.14%`, PF `1.545`, max DD `26.79%`, win `26.92%`; out-of-sample
  improved from return `74.10%`, PF `1.826`, max DD `19.17%`, win `42.25%` to return
  `121.40%`, PF `3.646`, max DD `11.11%`, win `39.39%`.
- Verified `bun run check` is clean and that current 15m output is byte-identical when only the
  runtime 1h block is toggled between the starting and tuned values.

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

### 2026-06-06 — Tasked Codex with iterative tuning of the 1h block
- **Scope:** tune ONLY the `1h` tuning block in `config.ts`. Leave 15m/2h/4h untouched.
- **Goal:** improve the 1h backtest/portfolio results — higher profit (return / profit
  factor) AND lower max drawdown — via iterative search (~100 iterations).
- **Anti-overfit rule:** judge on out-of-sample; only keep a change if it improves the
  out-of-sample segment, not just in-sample. Save best params + before/after numbers.
- **Status:** handed to Codex; 15m baseline must stay byte-identical.

### 2026-06-06 — Rejected the first 1h tune; re-tuning with hard rules
- **Rejected** the previous 1h tune: it made +338% on the recent 30% but LOST ~96% on the
  older 70% (blown account). That's overfitting to the recent window, not a real edge — the
  earlier tuning judged only the out-of-sample slice, which turned the holdout into training data.
- **New hard rules for re-tuning the 1h block (any failure = reject the settings):**
  1. Max drawdown ≤ 20% in every window.
  2. Must be profitable on the WHOLE history AND the older 70% AND the recent 30% — no
     window may lose money.
  3. Profit factor > 1.3 on the whole history.
- **Goal after rules pass:** highest return with the lowest drawdown; prefer lower drawdown.
- **If nothing passes:** Codex must stop and report, not force a fake-good result.
- Still 1h only; 15m/2h/4h untouched.

### 2026-06-07 — Tasked Codex with tuning the 2h block (same strict gates)
- **Scope:** tune ONLY the `2h` tuning block in `config.ts`. Leave 15m/1h/4h untouched.
- **Same hard rules as the 1h re-tune (any failure = reject):**
  1. Max drawdown ≤ 20% in every window.
  2. Profitable on the WHOLE history AND the older 70% AND the recent 30% — no window may lose money.
  3. Profit factor > 1.3 on the whole history.
- **Goal after rules pass:** highest return with lowest drawdown; prefer lower drawdown.
- **If nothing passes:** Codex must stop and report, not force a fake-good result.
- 2h history is ~417 days (regime interval 4h), so the backtest covers a deeper window than 1h.

<!-- Add your next entry above this line -->
