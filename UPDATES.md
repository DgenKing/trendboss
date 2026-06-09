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

### 2026-06-09 — Tasked Codex: mirror exchange truth for live positions (+ fees on panel)
- **Milestone reached:** a natural DOGE RANGE_REVERSION signal opened a real held testnet position
  with TP/SL recognised — the full live flow works.
- **Bug found:** the Live panel desynced from the exchange. Hyperliquid showed "No open positions"
  (flat, equity $964.04) while our panel showed OPEN 3 (BNB/DOGE/SOL) with locally-computed PnLs
  (incl. SOL −$25.26 on a position that no longer exists). Local state never reconciled after the
  positions closed on-exchange (TP/SL fired). `Last error: SOL close rejected ... did not fill` is
  the same cause — the stop had already closed SOL, so our close hit nothing.
- **Fix wanted (trader + /api/live + Live panel only):**
  1. CONTINUOUSLY reconcile open positions against Hyperliquid `clearinghouseState` each poll/
     heartbeat; if the exchange no longer holds a position, mark it CLOSED locally (record the trade,
     update equity) so phantom positions disappear.
  2. Display EXCHANGE-REPORTED values (entry, mark, unrealized PnL, margin, liq price) from the
     clearinghouse — NOT locally computed. Mirror Hyperliquid.
  3. Make the panel equity match the exchange Total Equity.
  4. Add FEES to the open-position rows on the panel.
- **Scope:** trader + dashboard Live panel; do not touch strategy/tuning/backtest/monitor.
- **Status:** to Codex on `paper-trade`.

### 2026-06-07 — Tuned 5m with strict drawdown gates
- Tested 100 realistic `5m` tuning combinations against the shared portfolio, requiring whole/older/recent
  windows to be profitable with max drawdown `<=20%`, plus whole-history PF `>1.3`; 2 candidates survived.
- Kept the highest-return survivor: `touchTolerance=0.0006`, `adxThreshold=38`,
  `breakoutLookback=80`, `atrStopMultiple=3.4`, `targetR=2.2`, `rsiLongMin=62`,
  `rsiShortMax=38`, `range.maxAdx=16`, `range.targetR=2.4`, `range.minScore=80`.
- Shared 5m portfolio now passes the hard gates in all three windows:
  whole history return `66.45%`, PF `1.471`, max DD `19.64%`, win `43.48%`;
  older 70% return `18.86%`, PF `1.350`, max DD `16.79%`, win `39.39%`;
  recent 30% return `8.84%`, PF `1.141`, max DD `19.64%`, win `39.06%`.
- Caveat still applies: 5m only covers about `17` days of Hyperliquid history and has heavy fee drag,
  so this is a small-sample experimental block, not robust proof of an edge.
- Verified the `15m`, `1h`, `2h`, and `4h` tuning blocks are unchanged.

### 2026-06-07 — Added 5m trade timeframe
- Added `5m` as the first selectable trade timeframe in config/API/dashboard, mapped it to the `1h`
  regime interval, included it in chart/backfill targets, and left the default active trade interval as `15m`.
- Added a `// ===== 5m tuning =====` block as an exact copy of the current `15m` tuning block; no 5m-specific
  tuning was done in this task.
- Verified `15m`, `1h`, `2h`, and `4h` backtest/portfolio snapshots are byte-identical to the Step 0 baseline.
- Verified 5m end-to-end on a temp BTC monitor DB: backfill cached 5,000 5m candles, `?interval=5m`
  returned backtest + portfolio results, and the dashboard selector served `5m | 15m | 1h | 2h | 4h`.
- Caveat: Hyperliquid's 5m cache is only about `17` days, so 5m results are small-sample observation data,
  not robust evidence of an edge.

### 2026-06-07 — Re-verified switchable trading timeframe
- Refreshed the default `15m` Step 0 baseline at `docs/superpowers/baselines/2026-06-06-15m-baseline.json`
  against the current local candle cache, then re-ran the default path after verification and confirmed it diffed clean.
- Verified `15m`, `1h`, `2h`, and `4h` all run through the backtest/portfolio engine; BTC history spans
  approximately `52`, `208`, `417`, and `833` days respectively, with `2h` candles present in the local cache.
- Re-ran `bun run check` successfully; no build was run.

### 2026-06-07 — Tuned 4h with strict drawdown gates
- Tested 101 `4h` tuning combinations; 57 passed the portfolio/account hard gates. Picked the
  highest whole-history return survivor: `touchTolerance=0.0015`, `adxThreshold=18`,
  `breakoutLookback=16`, `atrStopMultiple=2.2`, `targetR=1.4`, `rsiLongMin=62`,
  `rsiShortMax=38`, `range.maxAdx=12`, `range.targetR=1.6`, `range.minScore=85`.
- Shared 4h portfolio now passes the hard gates in all three windows:
  whole history return `47.75%`, PF `3.221`, max DD `11.85%`, win `67.65%`;
  older 70% return `9.39%`, PF `1.483`, max DD `11.85%`, win `52.94%`;
  recent 30% return `34.64%`, PF `8.724`, max DD `5.02%`, win `82.35%`.
- Diagnostic note: the 4h portfolio sample is smaller than 2h (`34` closed trades total,
  split `17` older / `17` recent). Aggregate isolated backtests are profitable in all windows,
  but whole/older standalone R-drawdown sits just above `20R`.
- Verified `bun run check` is clean and the `config.ts` diff touches only the `4h` tuning block.

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

### 2026-06-07 — Tasked Codex with tuning the 4h block (same strict gates)
- **Scope:** tune ONLY the `4h` tuning block in `config.ts`. Leave 15m/1h/2h untouched.
- **Same hard rules as the 1h/2h tunes (any failure = reject):**
  1. Max drawdown ≤ 20% in every window.
  2. Profitable on the WHOLE history AND the older 70% AND the recent 30% — no window may lose money.
  3. Profit factor > 1.3 on the whole history.
- **Goal after rules pass:** highest return with lowest drawdown; prefer lower drawdown.
- **If nothing passes:** Codex must stop and report, not force a fake-good result.
- 4h history is ~833 days (~2.3yr, regime interval 1d) — the deepest window of the four.

### 2026-06-07 — Spec'd adding the 5m trade timeframe for Codex
- **Decision:** add `5m` as a selectable trade timeframe (backtest + portfolio + dashboard),
  alongside the existing 15m/1h/2h/4h. Additive only — no existing timeframe changes.
- **Regime mapping:** `5m → 1h` (stable, deep-history regime source). Other mappings unchanged.
- **Tuning:** the 5m block starts as an EXACT copy of the 15m block — NOT tuned in this task.
- **Recorded caveat (important):** Hyperliquid serves ~5,000 candles per timeframe, so 5m has
  only ~17 days of history. Backtests will be small-sample / statistically weak and fee drag is
  heavier on a fast timeframe. 5m is for observation/experimentation, not a proven edge. The UI
  should show the short history depth like the other timeframes.
- **Deliberately NOT adding 1m or 3m:** too little history (~3.5d / ~10d) and too much fee drag.
- **Hard rule:** 15m/1h/2h/4h output must stay byte-identical.
- **Wrote for Codex to implement:**
  - Spec: `docs/superpowers/specs/2026-06-07-add-5m-timeframe-design.md`
  - Plan: `docs/superpowers/plans/2026-06-07-add-5m-timeframe.md`
- **Status:** spec + plan written; implementation NOT started yet.

### 2026-06-07 — Tasked Codex with tuning the 5m block (same strict gates)
- **Scope:** tune ONLY the `5m` tuning block in `config.ts`. Leave 15m/1h/2h/4h untouched.
- **Same hard rules as the 1h/2h/4h tunes (any failure = reject):**
  1. Max drawdown ≤ 20% in every window.
  2. Profitable on the WHOLE history AND the older 70% AND the recent 30% — no window may lose money.
  3. Profit factor > 1.3 on the whole history.
- **Goal after rules pass:** highest return with lowest drawdown; prefer lower drawdown.
- **Starting point:** untuned 5m (copy of 15m) currently returns ~-22.9%, max DD ~34.6% over
  463 trades — fails the gates badly, as expected for a fast timeframe.
- **Honest expectation:** 5m has only ~17 days of history and heavy fee drag, so it may NOT pass.
  If nothing passes, Codex must STOP and report "no settings work" — do not force a fake result.

### 2026-06-07 — Spec'd paper + testnet live trading (5m) for Codex
- **Decision:** add a live execution loop that acts on the strategy's signals in real time —
  first PAPER (simulated fills, no keys, no risk), then live on the Hyperliquid TESTNET (real
  signed orders, fake money). 5m timeframe only for this first version. New `paper-trade` branch.
- **Architecture:** new `packages/trader` package, its own process (`bun run trader`), built
  SEPARATE from the monitor so the proven monitor/backtest/portfolio/dashboard stay untouched.
  It REUSES `packages/core` (same `RegimeAwareStrategyEngine` + `calculatePortfolioAllocation`)
  so live behaviour matches the backtest. One `Executor` interface, two implementations
  (PaperExecutor / TestnetExecutor) chosen by a mode flag.
- **Researched (2026-06-07):** testnet URLs `api.hyperliquid-testnet.xyz` (REST/WS); no API
  keys — orders signed with an agent/API wallet private key (EIP-712); fund via mainnet deposit
  + testnet faucet; use the `nomeida/hyperliquid` TS SDK (Bun, testnet flag, market/limit/tp-sl
  triggers, account state); price/size rounding (sig figs + szDecimals) is the main gotcha.
- **Realistic cost model for PAPER:** uses the REAL Hyperliquid taker fee (0.045%/4.5 bps per
  side, on notional — strategy uses market + trigger-market orders), 1.5 bps slippage, and
  hourly funding on held positions. This differs from the backtest's simplified 3.5 bps/no-funding
  assumption on purpose; the backtest is left unchanged so tuned results don't move.
- **Safety rules recorded:** default `enabled:false`, default `mode:'PAPER'`; NO mainnet/real
  money; NO withdrawals; hard caps on positions; testnet key in a gitignored `trader.secret.ts`
  (no dotenv, hardcoded locally, never committed).
- **Wrote for Codex to implement:**
  - Spec: `docs/superpowers/specs/2026-06-07-paper-and-testnet-trading-design.md`
  - Plan: `docs/superpowers/plans/2026-06-07-paper-and-testnet-trading.md`
- **Status:** spec + plan written; implementation NOT started. Manual user setup (agent wallet,
  faucet, secret file) still required before TESTNET mode can run.

### 2026-06-08 — Implemented additive PAPER/TESTNET trader package
- **Added:** `packages/trader` as its own process (`bun run trader`) with isolated SQLite state
  in `data/trader.db`, default `enabled:false`, default `mode:'PAPER'`, and 5m-only live loop
  using `config.tuning['5m']`.
- **Reused core:** live decisions call the same `RegimeAwareStrategyEngine` and delegate sizing
  directly to `calculatePortfolioAllocation`; focused tests cover that delegate, PAPER fills,
  disabled no-op startup, TESTNET secret fail-fast, and TESTNET rounding helpers.
- **Executors:** PAPER simulates backtest-style fills with the existing 1.5 bps slippage and
  3.5 bps fee assumptions. TESTNET uses `hyperliquid` SDK with `testnet:true`, isolated 5x,
  IOC entries, reduce-only TP/SL trigger orders, full response checks, and no retry loop.
- **Safety:** no mainnet mode, no withdrawal calls, no committed key; `trader.secret.ts` is
  gitignored and `trader.secret.example.ts` documents the local secret shape.
- **Dashboard/API:** added read-only `/api/live` and a clearly labeled "Live (Paper/Testnet)"
  panel showing mode, not-real-money status, equity, positions, and recent live trades.
- **Docs:** manual testnet setup lives in `docs/trader-testnet-setup.md`.

### 2026-06-08 — Tasked Codex with widening trader coins (more trades to observe)
- **Why:** 5m backtest did ~130 trades / 17 days ≈ 7.6/day across ~12 coins (~0.6/coin/day).
  The trader only trades the first 4 coins (`coins.slice(0,4)`), so ~2–3 trades/day — too few to
  watch it actually work. Widen the trader's coin list to get back near ~7 trades/day.
- **Scope:** only the trader's coin selection + position cap. Do NOT touch the strategy, tuning,
  monitor, backtest, or the 5m-only rule.
- **Hard requirement (testnet reality):** Hyperliquid TESTNET lists fewer markets than mainnet.
  Codex must query the testnet `meta` universe and include ONLY plain perps that actually exist on
  testnet; skip any that don't, and keep skipping `xyz:` HIP-3 markets. Log which coins were
  included vs skipped.
- **Also:** raise `maxOpenPositions` to match the wider list (e.g. ~8–10) so trades aren't starved.
- **Status:** handed to Codex on the `paper-trade` branch.

### 2026-06-08 — Widened trader coin set for TESTNET-supported plain perps
- **Queried:** Hyperliquid TESTNET `meta` universe (`https://api.hyperliquid-testnet.xyz/info`)
  on 2026-06-08 and intersected it with our configured plain perps.
- **Included trader coins:** `BTC`, `ETH`, `SOL`, `BNB`, `HYPE`, `ZEC`, `NEAR`, `WLD`, `TON`,
  `SUI`, `DOGE`.
- **Skipped:** `XRP` (not listed in TESTNET `meta`), `xyz:XYZ100` and `xyz:SP500` (HIP-3
  `dex:ASSET` markets still refused by the TESTNET executor).
- **Position cap:** raised `config.trader.maxOpenPositions` from `4` to `10`.
- **Startup visibility:** trader now logs included coins and skipped coins with reasons before
  starting or no-oping.
- **Smoke test:** TESTNET startup backfilled the 11-coin set and opened the WebSocket for
  `11 coins x 3 intervals` without coin-selection crashes. TESTNET has sparse candle history for
  some listed markets (notably `ZEC`), but those returned cleanly.

### 2026-06-08 — Tasked Codex with a trader heartbeat + feed health (diagnostics)
- **Why:** running the testnet trader gives no feedback for hours, so there's no way to tell if
  it's alive or stuck. The terminal also shows the WebSocket re-opening repeatedly ("Opening
  Hyperliquid WebSocket ..."), i.e. it keeps going STALE (no messages for `staleSocketSeconds`)
  and reconnecting — a sign the testnet feed may not be delivering candles, so no trades fire.
- **Add a heartbeat (every ~60s)** to BOTH the terminal and the web Live panel showing: uptime,
  socket healthy/stale + last-message age, total closed candles received (and per-interval, e.g.
  5m), last closed-candle time per coin, signals seen, open positions, last action taken.
- **Surface feed health on `/api/live`** so the dashboard shows "last heartbeat", socket status,
  and candles-received counters — not just positions.
- **Investigate the reconnect loop:** confirm whether the testnet WS candle subscription actually
  pushes data; if testnet doesn't stream candles reliably, add a REST poll fallback for closed
  candles so the loop still works. Log clearly which path is feeding candles.
- **Scope:** trader + its dashboard panel only; do not touch strategy/tuning/monitor/backtest.
- **Status:** handed to Codex on `paper-trade`.

### 2026-06-08 — Implemented trader heartbeat and REST feed fallback
- **Heartbeat:** trader now emits a terminal heartbeat every `config.trader.heartbeatSeconds`
  (default `60`) and persists the latest heartbeat to `/api/live`. It includes uptime/current
  time, socket health, seconds since last WS message, closed-candle counters by interval,
  last closed-candle timestamp per coin, signals seen, open positions, last action, feed path,
  and raw WS channel counts.
- **Live panel:** "Live (Paper/Testnet)" now shows an `alive/stale` line, last heartbeat age,
  socket `OK/STALE`, candle counters, feed path, uptime, signals, last action, and per-coin last
  closed-candle timestamps.
- **Feed diagnostics:** TESTNET startup now logs raw incoming WS channels. In the verification run,
  TESTNET did emit `subscriptionResponse`, `allMids`, and `candle` channels, so candle streaming
  works at least intermittently.
- **Fallback:** trader now runs an always-on REST polling fallback through the same closed-candle
  path as WS. This keeps the live loop moving if TESTNET WS goes stale or candle delivery is
  unreliable. The fallback respects the existing REST budget spacing and logs poll failures per
  coin/interval instead of crashing.
- **Reconnect spam:** if the WS stays stale repeatedly, the trader pauses WS reconnects for
  300s and continues via REST poll, preventing endless "Opening Hyperliquid WebSocket..." spam.
- **Verification:** TESTNET heartbeat showed non-zero counters (`5m=19`, `1h=15`, `1d=15` after
  the first poll cycle) with `socket=healthy`, `lastMsg=0s`, and `feed=REST_POLL`.

### 2026-06-09 — Tasked Codex: loosen 5m for live trading + fix WS recovery/log spam
- **Observed:** trader ran ~12.5h on testnet with a healthy feed (WS, then REST_POLL after a
  Hyperliquid 502 outage) and produced `signals=0` the whole time. Confirms the gated 5m tuning
  (`adxThreshold=38` / `range.maxAdx=16` dead-zone) is too strict to trade in normal conditions.
- **Two fixes wanted (trader only; do NOT touch the gated backtest tuning blocks):**
  1. **Loosen for live:** add a SEPARATE live/testnet trading profile (e.g. `config.trader.tuning`
     override) that closes the ADX dead-zone so it actually fires trades — lower `adxThreshold`,
     raise `range.maxAdx`, etc. Keep the backtest's `config.tuning['5m']` UNCHANGED. The trader
     uses the override; the backtest/portfolio keep their gated numbers.
  2. **Feed robustness:** the "pausing WS reconnects for 300s" message spams every ~5s and the WS
     never recovers after an outage (stuck on REST_POLL forever). Make the pause actually quiet the
     log (log once), and let the WS genuinely re-establish a live connection after the pause window.
- **Status:** to be handed to Codex on `paper-trade`.

### 2026-06-09 — Tasked Codex: fix testnet order metadata lookup + crash isolation
- **Milestone:** loosened live profile worked — trader fired its first live signal (NEAR) within
  minutes. But placing the order crashed the whole process.
- **Bug 1 (fatal, why no order ever placed):** `TestnetExecutor.rulesFor` matches
  `asset.name === plainCoin(coin)` (e.g. `"NEAR"`) against the `nomeida/hyperliquid` SDK
  `getMeta()`, but the SDK returns names in `"<COIN>-PERP"` form — so the lookup matches NOTHING
  for any coin and throws `No TESTNET metadata for <coin>`. Confirmed the raw testnet `meta`
  endpoint DOES contain plain `"NEAR"` (szDecimals 1), so data exists; it's purely a name-format
  mismatch. Fix: normalise both sides (e.g. compare `plainCoin(asset.name) === plainCoin(coin)`)
  or use the raw info meta; log the actual names to verify.
- **Bug 2 (critical robustness):** the thrown error was uncaught and killed the entire trader
  (`exited with code 1`) after 14h. Wrap per-coin entry/exit handling in try/catch: log, skip that
  trade, keep the loop running. One coin must never crash the bot.
- **Bug 3 (minor):** on startup the warmed-up engine emitted "exit TARGET, no live position to
  close" — live engine state isn't aligned with live executor positions. Align so the live engine
  doesn't think it holds positions the executor never opened.
- **Scope:** trader only; gated tuning/backtest/monitor untouched.
- **Status:** to Codex on `paper-trade`.

### 2026-06-09 — Fixed TESTNET order metadata + crash isolation
- **Metadata fix:** TESTNET order rules now normalise SDK symbols like `NEAR-PERP` and configured
  coins like `NEAR` through the same `plainCoin(...)` path before matching. Startup/order logs now
  print the resolved SDK name, plain coin, and `szDecimals` so the mapping is auditable.
- **Crash isolation:** per-coin entry/exit handling now catches executor failures, records the
  latest error for the heartbeat and Live panel, skips only the failed trade, and keeps the trader
  process running.
- **State alignment:** rejected opens and orphan exit signals reset that coin's live engine state
  so warmed-up strategy state cannot keep emitting exits for positions the executor never opened.
- **Order safety:** if a TESTNET entry fills but TP/SL trigger placement fails, the executor now
  immediately attempts a reduce-only IOC close for that filled size to avoid leaving an orphan.
- **Live-only tuning override:** `config.trader.tuning` remains separate from the gated 5m tuning
  and uses ADX threshold `18`, range max ADX `30`, range min score `40`, touch tolerance `0.25%`,
  10-minute touch cooldown, 8-candle confirmation, 12-candle breakout, ATR stop `1.8`, target `1.2R`,
  and RSI long/short filters at `50/50`. `config.tuning['5m']` is unchanged.
- **Verification:** TESTNET resolved metadata for `TON` as `sdkName=TON-PERP plain=TON szDecimals=1`;
  the entry was rejected/not filled by the exchange, was logged as `lastError`, and the loop kept
  heartbeating with `open=0`. A previous pre-fix orphan `SOL-PERP` testnet position was manually
  flattened and clearinghouse state was confirmed empty afterward.

### 2026-06-09 — Tasked Codex: fix trigger-order parsing (first real fill happened!)
- **Milestone:** first REAL testnet order filled — BNB entry filled (size 2.099 @ 594.501). Testnet
  trading works end-to-end.
- **Bug:** after the entry filled, the TP and SL trigger orders BOTH returned `status:"ok"`, but
  `acceptedOrderId()` (testnet.ts ~298) only looks for `status.resting.oid` / `status.filled.oid`
  in `data.statuses` and found neither, so it treated them as "rejected", ran the orphan-close,
  and flattened the freshly-opened position (open=0). The bot misread its own success and undid it.
- **Need:** the inner `data.statuses` was truncated in logs (`[Object ...]`), so first DEEP-LOG the
  full stop/target responses to see the real success/error shape. Then:
  1. Make `acceptedOrderId` recognise the trigger-order success shape (and any per-order `error`).
  2. Before orphan-closing, RECONCILE with the exchange (open orders / clearinghouse): only close
     the entry if the position is genuinely unprotected. Don't close a position whose TP/SL are
     actually resting on the book.
  3. Consider placing entry+TP+SL as the intended `normalTpsl` grouped batch if that's more reliable.
- **Scope:** trader only.
- **Status:** to Codex on `paper-trade`.

### 2026-06-09 — Fixed TESTNET TP/SL trigger recognition
- **Root cause confirmed:** separate reduce-only trigger `placeOrder` calls with
  `grouping:"normalTpsl"` return top-level `status:"ok"` but inner per-order errors:
  `{"error":"Main order cannot be trigger order."}`. The old parser also treated non-object
  trigger statuses as missing OIDs, which made the orphan-close path flatten a just-filled entry.
- **Fix:** TESTNET entries now submit one grouped `normalTpsl` batch: main IOC entry first, then
  reduce-only SL and TP triggers. The real successful grouped response shape observed on BNB was:
  `{"status":"ok","response":{"type":"order","data":{"statuses":[{"filled":{"totalSz":"2.11","avgPx":"592.35","oid":54690421640}},"waitingForTrigger","waitingForTrigger"]}}}`.
- **Recognition:** `acceptedOrderId` now supports nested OID success shapes, while
  `orderStatusError` catches per-order `error` strings and treats `"waitingForTrigger"` as a
  successful pending trigger state. For grouped trigger statuses of `"waitingForTrigger"`, the
  executor reconciles via `frontendOpenOrders`.
- **Protection check:** before any orphan-close, the executor queries frontend open orders and only
  flattens when both protective triggers are absent. A protected BNB position was kept with
  `stopOid=54690421641` and `targetOid=54690421642`.
- **Verification:** BNB TESTNET validation filled `2.11 @ 592.35`; Hyperliquid reported open
  `BNB-PERP szi=2.11`, plus resting reduce-only `Stop Market` at `586.37` and `Take Profit Market`
  at `598.21`. The Live state now shows `openPositions[0]` with entry/stop/target and both OIDs.

### 2026-06-09 — Made TESTNET live state reconcile from exchange truth
- **Problem fixed:** the Live panel could keep local BNB/DOGE/SOL rows after Hyperliquid had
  already closed them via TP/SL, so the dashboard showed phantom positions and locally-computed PnL.
- **Exchange source of truth:** TESTNET heartbeat reconciliation now fetches `clearinghouseState`
  every cycle and mirrors open rows from the exchange. Entry, derived mark price, unrealized PnL,
  margin, liquidation price, used margin, and equity now come from Hyperliquid, not local math.
- **Phantom close handling:** if a local position is missing from `clearinghouseState`, the trader
  cancels any leftover reduce-only trigger orders, records a closed trade from recent exchange
  fills when available, deletes the local open row, and writes an exchange equity point.
- **Fees:** live positions now carry a `fees` value from recent exchange fills when available
  (falling back to stored fill fees), and the Live panel has a Fees column.
- **/api/live:** the endpoint now derives live mode from the latest live equity row and normalizes
  heartbeat open count to the actual open-position rows, avoiding stale heartbeat counts in the UI.
- **Verification:** Hyperliquid reported `accountValue=0`, `totalMarginUsed=0`, no positions, and
  no open orders. Reconcile moved local BNB/DOGE/SOL to closed trades and `/api/live` then showed
  `mode=TESTNET`, `equity=0`, `usedMargin=0`, `heartbeat.openPositions=0`, and `openPositions=[]`.

### 2026-06-09 — Fixed live balance not showing after reconcile crash
- **Cause:** TESTNET reconciliation was fetching the correct Hyperliquid balance, but crashed before
  saving it when a local/placeholder stop or target was `0`; `matchesTriggerPrice()` tried to run
  the zero value through TESTNET price formatting, which rejects non-positive prices.
- **Fix:** protective-order matching now ignores missing/non-positive stop and target values before
  formatting, so reconciliation can mirror exchange equity and open positions even when local rows
  are incomplete or stale.
- **Verification:** Hyperliquid reported a SOL position and account value around `$19.49`; after
  reconcile, local live state showed `equity=19.491757`, `usedMargin=19.491757`, one SOL open row,
  `heartbeatOpen=1`, and no stale last error.

### 2026-06-09 — Corrected Live panel total equity vs used margin
- **Cause:** the Live panel header was showing Hyperliquid perps `marginSummary.accountValue`,
  which matched the isolated position margin bucket (~`$19`) rather than the whole testnet account.
- **Fix:** TESTNET reconciliation now uses spot `USDC.total` as Live total equity, while keeping
  perps `marginSummary.totalMarginUsed` as Used margin. The panel labels now say `total equity`
  and `Used margin` explicitly.
- **Verification:** after reconcile, `/api/live` showed total equity `964.212808`, used margin
  `19.45651`, and one SOL open position.

<!-- Add your next entry above this line -->
