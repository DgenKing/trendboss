# TrendBoss — Testnet Live-Trading (Paper Trade) Analysis Report

**Date:** 2026-06-10
**Branch:** `paper-trade` (clean, up to date with origin)
**Scope:** Live trading loop on Hyperliquid TESTNET, 5-minute timeframe, 11 coins (BTC, ETH, SOL, BNB, HYPE, ZEC, NEAR, WLD, TON, SUI, DOGE).

---

## TL;DR

The system is fundamentally working: candles flow in over WebSocket with a REST-poll fallback, signals fire, orders (entry + stop + take-profit as a grouped TPSL bundle) are placed on the testnet exchange, exits are reconciled back from exchange state, and everything is persisted to `data/trader.db`. All 35 tests pass and `tsc --noEmit` is clean.

**However: the trader is NOT currently running.** The last heartbeat was **2026-06-09 20:31 UTC** (about a day ago), and there is **one open SOL position still live on the exchange** with no bot supervising it. It does have a resting stop and take-profit on the exchange, so it is protected, but nobody is reconciling or managing it.

There was also a serious equity-corruption window on June 9 (now fixed by commit `7d865aa`), plus a handful of smaller bugs detailed below.

---

## 1. Current State

| Item | Status |
|---|---|
| Trader process | **Not running** (last heartbeat 2026-06-09 20:31 UTC, uptime 4,438 s) |
| Feed health at last heartbeat | Socket healthy, feed=WS, 0 s since last message — it was healthy when it stopped |
| Open positions | 1 — SOL LONG, qty 1.48, entry 65.098, stop 64.604 (oid 54707419862), target 66.133 (oid 54706786549) |
| Closed trades | 4 (net **-28.06 USDC** after fees) |
| Equity | 1,000 → **960.85** (-3.9%) |
| Tests | **35 pass, 0 fail** |
| TypeScript | **Clean** (`tsc --noEmit` exit 0) |

The process appears to have been stopped (or the machine rebooted) rather than crashed — the final heartbeat showed a healthy socket and fresh candles. **Action: restart with `TRADER_ENABLED=true TRADER_MODE=TESTNET bun run trader`** (it resumes positions from `trader.db` and reconciles against the exchange on startup).

### Closed trades

| Coin | Strategy | Entry | Exit | PnL | Reason | Recorded exit time |
|---|---|---|---|---|---|---|
| BNB | RANGE_REVERSION | 592.35 | 584.55 | -17.01 | STOP | 16:34:44 |
| DOGE | RANGE_REVERSION | 0.084501 | 0.084829 | +4.21 | TARGET | 16:34:44 |
| SOL | RANGE_REVERSION | 65.1743 | 64.5628 | -12.29 | STOP | 16:34:44 |
| WLD | TREND_MOMENTUM | 0.5209 | 0.51983 | -2.97 | TARGET (mislabelled — see issue #4) | 19:20:13 |

---

## 2. The big incident: equity recorded as $0 (2026-06-09 16:19–18:49 UTC)

For ~2.5 hours the reconcile loop wrote `equity = 0` / `realizedBalance = 0` to the database. During candle closes the account showed equity ≈ **$19.37** (unrealized PnL only, since realized balance had been zeroed). Consequences:

- **All 6 `NO_MARGIN` rejections** in `live_decisions` happened in this window — the allocator rejects when equity ≤ 0, so valid signals (SOL, WLD, BNB, DOGE between 17:04 and 18:59) were thrown away.
- The **currently-open SOL position was sized off corrupted equity**: allocation logic saw ~$19 of equity, so it opened only 1.48 SOL (~$97 notional, $19.92 margin) instead of the normal ~$1,250 notional / $250 margin sizing. That position is still open.

**Root cause:** the old reconcile used the perps `marginSummary.accountValue`, which was 0 because the testnet funds sit in the **spot** USDC balance. Commit `7d865aa` (Jun 9 21:05 +0100) fixed this by reading the spot USDC balance — and equity has read correctly (~960) since the restart at 19:17 UTC.

**Residual risk in the fix** (`totalAccountEquity`, `packages/trader/testnet.ts:693`):
1. It **prefers spot USDC and ignores the perps-side value entirely**. When a position is open, the margin transferred to perps disappears from the equity number — current reading 960.85 excludes the ~$20 of margin + unrealized PnL sitting in the perps clearinghouse. True equity is closer to ~981. Correct formula is roughly `spot USDC + perps accountValue`.
2. If you ever move all funds into perps, spot USDC becomes literally `"0"`, which is a valid number — `numeric("0", fallback)` returns 0 and **the equity-zero bug comes straight back**. The fallback only triggers when the field is missing, not when it is zero.

---

## 3. Other issues found

### 3.1 Reconciled exit times are wrong (bug)
`packages/trader/testnet.ts:635`:
```ts
const exitTime = Math.max(...closing.map((fill) => fill.time), Date.now());
```
`Date.now()` is *inside* the `Math.max`, so the recorded exit time is always the reconcile time, never the actual fill time. That's why BNB, DOGE and SOL all show the identical exit timestamp 16:34:44 — they actually exited on the exchange at different times before that. Fix: use the latest closing-fill time and only fall back to `Date.now()` when there are no closing fills.

### 3.2 Exit-reason inference mislabels trades
The WLD trade is recorded as `TARGET` with a **negative** PnL (-2.97): entry 0.5209, exit 0.51983, opened 18:59 and flat ~20 minutes later. `inferExitReason` (`testnet.ts:655`) guesses the reason from the exit price vs the mirrored stop/target with a 0.1% tolerance, and the mirrored stop/target can come from whatever protective orders happen to be resting. Treat `exitReason` on reconciled trades as approximate; consider deriving it from which trigger order (stop oid vs target oid) actually filled in the user-fills feed instead.

### 3.3 Duplicate signal processing after restart
TON shows the same decision pair (ACCEPTED + EXECUTOR_REJECTED) recorded **twice at the identical timestamp** (04:34:59). Mechanism: the REST poll restarts from `lastCandleTime - intervalMs` (`feed.ts:281`), the in-memory dedup set (`feed.processed`) is empty after a restart, and the strategy engines are rebuilt fresh — so the last saved candle is re-processed and the same signal can fire again. Harmless when the executor rejects or the symbol is already active, but it can double-place an order in the wrong circumstances. Consider seeding the dedup set from the DB on startup, or only polling candles strictly newer than the last saved one.

### 3.4 ZEC is dead on testnet
ZEC has **1 daily candle and its last 5m candle is from 2025-10-03** — the market effectively doesn't trade on testnet. It's still in the included coin list, so every backfill/poll cycle wastes REST budget on it, and it can never produce valid levels or signals. Recommend removing ZEC from `TESTNET_SUPPORTED_TRADER_COINS` in `config.ts` (or excluding it the same way XRP and the HIP-3 markets are).

### 3.5 Engine/exchange exit race (cosmetic, by design but noisy)
Last heartbeat error: `WLD engine exit TARGET ignored: no live position`. The exchange-side trigger filled first, the reconcile loop closed the local position, and then the strategy engine also signalled the exit on the next candle and found nothing to close. The code handles this safely (logs, resets the engine), but it surfaces as `lastError`, which makes a normal occurrence look like a fault. Consider downgrading this to an info log.

### 3.6 Equity-point duplication (minor)
`live_equity_points` gets one row per coin per 5m close (8–10 identical rows per timestamp, 3,015 rows for ~29h). Harmless, but it bloats the DB and makes queries noisier. Saving once per candle timestamp would be cleaner.

---

## 4. What's working well

- **Crash isolation:** every candle handler and executor call is wrapped; one coin's failure can't kill the loop.
- **Feed resilience:** WS with stale detection, exponential-backoff reconnect, a 5-minute WS pause after repeated staleness, and a REST-poll fallback that kept candles flowing (heartbeat showed SUI arriving via REST_POLL while WS handled the rest).
- **Order safety:** entries go out as a grouped `normalTpsl` bundle (entry IOC + stop trigger + TP trigger). If the protective triggers don't rest, the code cancels what it can and force-closes the orphan entry. The current SOL position is verifiably protected (both trigger oids resting).
- **Reconciliation:** exchange state is the source of truth — positions are mirrored from the clearinghouse, exchange-flat positions are moved to closed trades, and orphaned protective orders are cancelled.
- **Safety rails:** refuses to start the TESTNET executor against a non-testnet URL; refuses HIP-3 dex markets; hard-fails if `tradeInterval !== '5m'`; secrets live in gitignored `trader.secret.ts`.
- **Quality gates:** full test suite green, no type errors, clean working tree.

---

## 5. Recommended actions (priority order)

1. **Restart the trader** — there's a live, unsupervised SOL position on the exchange (protected by triggers, but unmanaged).
2. **Fix `totalAccountEquity`** to sum spot USDC + perps account value, and treat `0` spot balance as a real value only when perps value is also included (prevents both the undercount and a regression of the equity-zero bug).
3. **Fix the `exitTime` `Math.max(..., Date.now())` bug** at `testnet.ts:635`.
4. **Decide what to do with the undersized SOL position** — it was opened off corrupted ($19) equity; closing and letting the strategy re-enter at proper size is reasonable.
5. Remove **ZEC** from the testnet coin list.
6. Harden restart behaviour against duplicate candle re-processing (seed dedup from DB).
7. (Nice-to-have) derive reconciled exit reasons from which trigger oid filled; dedupe equity points; downgrade the engine-exit-with-no-position message from error to info.
