# Paper + Testnet Live Trading (5m) — Implementation Plan

**Date:** 2026-06-07
**Spec:** `docs/superpowers/specs/2026-06-07-paper-and-testnet-trading-design.md`
**Branch:** `paper-trade`
**For:** Codex

Read the spec first. Core rules: ADDITIVE only (don't touch monitor/backtest/portfolio/
dashboard behaviour), REUSE `packages/core` (no re-implementing the strategy), default mode
`PAPER`, **5m only**, no mainnet, no withdrawals.

---

## Step 0 — Safety snapshot (before editing)

- Capture current `bun run check` result and a 5m + (one higher) backtest/portfolio output.
- At the end, confirm these are unchanged — the trader must not alter existing behaviour.

## Step 1 — Config + secrets

- Add the additive `trader` section to `config.ts` (see spec). Default `enabled: false`,
  `mode: 'PAPER'`, `tradeInterval: '5m'`.
- Add `trader.secret.ts` to `.gitignore`. Create a `trader.secret.example.ts` template
  (committed) showing `export const TESTNET_AGENT_KEY = '0x...'`. The real file is never committed.
- `TESTNET` mode must fail fast with a clear message if the secret file/key is missing.
  `PAPER` mode needs no key.

## Step 2 — Add the SDK

- Add the `nomeida/hyperliquid` TypeScript SDK as a dependency (Bun). Confirm it imports and
  runs under Bun. It is only used by the TESTNET executor.

## Step 3 — `packages/trader` scaffolding

- Create `types.ts`, `account.ts`, `store.ts` (SQLite; separate tables/db so it never
  collides with the monitor's data), and the `Executor` interface.
- `store.ts`: persist live decisions, fills, open positions, closed trades, equity points.

## Step 4 — Feed (`feed.ts`)

- Reuse the monitor's Hyperliquid client/WS to stream **closed 5m candles** for the configured
  coins, plus the 1h regime candles and daily candles for levels. Only act on CLOSED candles.

## Step 5 — The loop (`index.ts`)

- For each closed 5m candle: update levels + 1h regime, run `RegimeAwareStrategyEngine.update`
  with `config.tuning['5m']`, handle exits first, then entries.
- Size entries with `calculatePortfolioAllocation` using `config.portfolio` settings against
  tracked equity/used margin. Respect `trader.maxOpenPositions`.
- Route all opens/closes through the selected `Executor`. Persist everything.

## Step 6 — PaperExecutor (`paper.ts`)

- Simulated fills using the SAME assumptions as `backtest.ts` (1.5 bps slippage, 3.5 bps fee
  per side; entry at open; exit at stop/target when the candle range hits it).
- Update `account.ts`/`store.ts`. Must reconcile with the backtest for the same candles.

## Step 7 — TestnetExecutor (`testnet.ts`)

- Init SDK with `testnet: true` + agent key. On entry: set leverage (5x isolated), place
  market (IOC) entry, place reduce-only `tp`/`sl` trigger orders (`normalTpsl`).
- On exit/trigger fill: cancel sibling trigger, reconcile to flat.
- Use `getClearinghouseState` as source of truth for positions/margin/equity.
- Round price/size to asset rules (sig figs + `szDecimals` from `meta`); verify acceptance;
  log full response on rejection; no blind retries.

## Step 8 — Dashboard (read-only, additive)

- Add `GET /api/live` returning the trader's current state from its store.
- Add a "Live (Paper/Testnet)" panel: mode badge, equity, open positions, recent closed
  trades, equity line. Label clearly + "not real money". Don't change existing views/endpoints.

## Step 9 — Scripts + tests

- Add `bun run trader` to `package.json` (runs `packages/trader/index.ts`).
- Tests: (a) live sizing calls the same `calculatePortfolioAllocation` as the portfolio
  backtest; (b) PAPER fills match backtest logic on a fixed candle fixture; (c) `enabled:false`
  is a no-op; (d) TESTNET refuses to start without the secret.

## Step 10 — Verify & log

- `bun run check` clean. Existing backtest/portfolio output unchanged vs Step 0.
- Demonstrate PAPER mode opening/closing simulated 5m trades end-to-end.
- Document the manual testnet setup (agent wallet, faucet, secret file, enabling steps).
- Add a dated entry to `UPDATES.md`.

---

## Definition of done

- [ ] `packages/trader` runs as its own process via `bun run trader`.
- [ ] Reuses `packages/core` engine + `calculatePortfolioAllocation` (verified by test).
- [ ] PAPER mode works end-to-end on live 5m candles and reconciles with backtest.
- [ ] TESTNET mode can set leverage, place entry + tp/sl, read state, and close (with a funded
      agent wallet) — prices/sizes rounded and accepted.
- [ ] Default `enabled:false`, default `mode:'PAPER'`; no mainnet path; no withdrawals.
- [ ] Testnet key in gitignored `trader.secret.ts`; example template committed.
- [ ] Dashboard shows live state, clearly labelled; existing views/endpoints unchanged.
- [ ] `bun run check` clean; existing backtest/portfolio output unchanged.
- [ ] `UPDATES.md` updated; manual setup steps documented.
```
