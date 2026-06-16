# Paper + Testnet Live Trading (5m) — Design Spec

**Date:** 2026-06-07
**Author:** DgenKing (via Claude)
**Branch:** `paper-trade`
**Status:** Approved for implementation by Codex

---

## Objective

Add a **live execution loop** that takes the signals from the existing strategy engine
and actually acts on them in real time — first as **paper trading** (simulated fills, no
keys, no risk), then as **live trading on the Hyperliquid testnet** (real signed orders,
fake money). **5m timeframe only** for this first version.

This is for validation: leave it running and see whether the live behaviour matches the
backtest before any real money is ever considered.

## NON-NEGOTIABLE CONSTRAINTS

1. **Do not modify the existing monitor, backtest, portfolio, or dashboard behaviour.**
   The trader is ADDITIVE: a new package and a new process. The proven parts stay intact.
   `bun run check` must still pass and existing backtest/portfolio output must be unchanged.
2. **Reuse `packages/core` as-is.** The live loop MUST use the same `RegimeAwareStrategyEngine`
   and the same position-sizing math (`calculatePortfolioAllocation`) that the backtest uses.
   Do NOT re-implement the strategy. If live and backtest disagree, that's a bug.
3. **Two modes behind one flag:** `PAPER` and `TESTNET`. Default is `PAPER`. `TESTNET` must
   be explicitly turned on. There is NO mainnet/real-money mode in this task at all.
4. **5m only.** Use the tuned `5m` block from `config.tuning['5m']`. Do not trade other intervals.
5. **Safety first.** No withdrawals, ever. Hard caps on position size and number of positions.
   If anything is uncertain at runtime (missing price, bad fill, API error), do nothing and log.

## Background facts (researched 2026-06-07)

- **Testnet base URLs:** REST `https://api.hyperliquid-testnet.xyz`, WS
  `wss://api.hyperliquid-testnet.xyz/ws`. Same request formats as mainnet.
- **Auth:** no API keys. Orders are signed with a **wallet private key** (EIP-712). Use an
  **agent / API wallet** (approved by the master account) that can trade but cannot withdraw.
- **Funds:** deposit once on mainnet with the same address, then claim 1,000 mock USDC from
  the testnet faucet (`https://app.hyperliquid-testnet.xyz/drip`). This is a manual user step.
- **SDK:** use the maintained TypeScript SDK `nomeida/hyperliquid` (works with Bun, supports
  `testnet: true`, agent wallets, market/limit/trigger orders, and reading account state). Let
  the SDK handle signing and price/size formatting. Do NOT hand-roll EIP-712 signing.
- **Order action** (`/exchange`, type `order`): asset index (from `meta.universe`), `b` isBuy,
  `p` price string, `s` size string, `r` reduceOnly, order type `limit{tif}` or
  `trigger{isMarket,triggerPx,tpsl}`. Stops/targets are native **trigger orders** with
  `grouping: "normalTpsl"`.
- **Gotcha — price/size rounding:** Hyperliquid rejects prices with too many significant
  figures (~5 sig figs for perps) and sizes finer than the asset's `szDecimals` (from `meta`).
  The SDK helps, but Codex MUST verify orders are accepted and round correctly.

## Architecture

New package **`packages/trader`**, run as its own process (`bun run trader`). Shape:

```
packages/trader/
├── index.ts        # entry: wires feed -> engine -> executor -> store, main loop
├── feed.ts         # live 5m candle source (reuse the monitor's HL client/WS) + 1h regime candles
├── account.ts      # tracked account state (equity, open positions, realized balance)
├── executor.ts     # interface: PaperExecutor | TestnetExecutor (same methods)
├── paper.ts        # PaperExecutor: simulated fills using the SAME rules as backtest
├── testnet.ts      # TestnetExecutor: real orders via the Hyperliquid SDK on testnet
├── store.ts        # SQLite persistence for live trades/positions/equity (separate table or DB)
└── types.ts        # shared trader types
```

The executor is an **interface with two implementations**, chosen by the mode flag. The rest
of the loop is identical in both modes — this is what makes PAPER a true rehearsal for TESTNET.

## The live loop (per closed 5m candle)

1. A 5m candle closes for a coin → feed delivers it (only act on CLOSED candles, never the
   forming one — same rule as the monitor).
2. Update levels (daily) and the 1h regime snapshot, exactly as the monitor does.
3. Run `RegimeAwareStrategyEngine.update(...)` for that coin with `config.tuning['5m']`
   options. This yields the same signals/exits the backtest would produce.
4. **Exits first:** if the engine reports the active trade should exit (stop/target hit on
   this candle), close the position via the executor.
5. **Entries:** if the engine emits a new signal and the coin has no open position, size it
   with `calculatePortfolioAllocation` against current tracked equity + used margin (reuse the
   exact portfolio settings: $1,000 start, 5x leverage, 2% risk, 25%/100% margin caps). If the
   allocation is ACCEPTED/PARTIAL, open the position via the executor; if REJECTED, log and skip.
6. Persist the decision, fills, position, and updated equity to the trader store.
7. Expose the live state so the dashboard can show it (see Dashboard section).

> Entry timing: the backtest enters at the next candle's open. Live, the signal fires when
> candle N closes, so the entry is a market order placed immediately after close (≈ next
> candle open). Document this small, unavoidable difference.

## PAPER mode (`paper.ts`)

- No keys, no network writes. Simulated fills using the same fill LOGIC as `backtest.ts`
  (entry at candle open; exit at stop/target when the candle range hits it; otherwise hold),
  BUT with a **realistic Hyperliquid cost model** so this is a true-cost simulation, not the
  backtest's simplified one.

### Realistic cost model (REQUIRED — the user wants a full simulation)

Confirmed Hyperliquid figures (2026), all charged on **notional** (the full leveraged
position size), not on margin:

- **Taker fee = 0.045% (4.5 bps) PER SIDE.** The strategy enters with market orders and exits
  via trigger-market (stop/target) orders, so both sides are taker. Charge 4.5 bps on entry
  notional and 4.5 bps on exit notional. (Do NOT use the maker 0.015% rate — no post-only orders.)
- **Slippage = 1.5 bps per side** (keep the existing assumption; entries/exits are market).
- **Funding = hourly holding cost.** For any position open across an hourly funding snapshot,
  apply a funding charge/credit on notional. Use the live/last funding rate from Hyperliquid if
  readily available via the existing client; if not, make the per-hour funding rate a config
  value (`trader.assumedHourlyFundingRate`, small default) so it is at least modelled, not zero.
  Longs pay positive funding / receive negative; shorts the opposite. Document which source is used.
- Make these costs **config-driven** under `trader` (e.g. `takerFeeRate: 0.00045`,
  `slippagePerSide: 0.00015`, funding handling above) so they can be updated if Hyperliquid
  changes its schedule.

- Maintains simulated equity/positions in `account.ts` + `store.ts`.
- NOTE: because PAPER uses the *real* taker fee (4.5 bps) and funding, its results will differ
  slightly from the existing backtest (which assumes 3.5 bps and no funding). That is expected
  and correct — PAPER reflects reality. Do NOT change the backtest's fee assumptions in this
  task (that would alter the tuned results); just make PAPER more realistic. Reconciliation
  against the backtest is therefore "same trades/direction/timing", not "identical PnL".

## TESTNET mode (`testnet.ts`)

- Uses the Hyperliquid SDK with `testnet: true` and the agent wallet private key.
- On entry: set leverage (5x, isolated) for the asset, then place a **market order** (IOC) for
  the sized quantity, then place reduce-only **trigger orders** for the stop (`sl`) and target
  (`tp`) using `grouping: "normalTpsl"`.
- On exit signalled by the engine, or when a trigger order fills: cancel the sibling
  trigger and reconcile the position to flat.
- Read true account state from `getClearinghouseState` (positions, margin, balance) and use it
  to keep `account.ts` honest — do not blindly trust local assumptions; the exchange is the
  source of truth in testnet mode.
- Round all prices/sizes to the asset's rules (sig figs + `szDecimals` from `meta`). Verify
  each order is actually accepted; on rejection, log the full response and do not retry blindly.

## Config additions (`config.ts`)

Add a `trader` section (additive; do not touch existing fields):

```ts
trader: {
  enabled: false,            // master off-switch
  mode: 'PAPER',             // 'PAPER' | 'TESTNET'
  tradeInterval: '5m',       // 5m only for now
  coins: [...],              // subset to trade; default to config.coins or a small list
  testnetRestUrl: 'https://api.hyperliquid-testnet.xyz',
  testnetWsUrl:  'wss://api.hyperliquid-testnet.xyz/ws',
  maxOpenPositions: 4,       // hard safety cap
  // sizing reuses config.portfolio ($1,000, 5x, 2% risk, 25%/100% caps)
  // realistic cost model (see PAPER mode section):
  takerFeeRate: 0.00045,     // 4.5 bps per side (Hyperliquid base taker, on notional)
  slippagePerSide: 0.00015,  // 1.5 bps per side
  assumedHourlyFundingRate: 0.0000125, // fallback hourly funding if live rate unavailable
},
```

### SECRET HANDLING — important

Do NOT commit the testnet private key. The project convention is "no dotenv, hardcode in
config", but a private key in a public repo is unsafe even on testnet. Compromise that keeps
both rules:

- Read the agent-wallet private key from a **gitignored** file `trader.secret.ts`
  (e.g. `export const TESTNET_AGENT_KEY = '0x...'`), imported by the trader. Add
  `trader.secret.ts` to `.gitignore`. No dotenv, value still hardcoded locally, never committed.
- If the file is missing, `TESTNET` mode must refuse to start with a clear error. `PAPER` mode
  needs no key.

## Dashboard (read-only, additive)

- Add a **"Live (Paper/Testnet)"** panel showing: current mode, equity, open positions
  (coin, direction, entry, stop, target, unrealised PnL), recent closed live trades, and a
  simple equity line. Reuse existing components where possible.
- New read-only endpoint(s) on the monitor API (or a small endpoint in the trader process),
  e.g. `GET /api/live` returning the trader's current state from its store. Do not change
  existing endpoints' behaviour.
- Clearly label the panel **PAPER** or **TESTNET** and "not real money".

## Validation / acceptance criteria

1. Existing `bun run check` passes; backtest/portfolio output unchanged; monitor unaffected.
2. PAPER mode runs the 5m loop end-to-end on live candles and opens/closes simulated trades
   that match the backtest in trades/direction/timing for the same candles (PnL differs because
   PAPER uses the realistic 4.5 bps taker fee + funding — that is expected). Verify the realistic
   cost model is applied: 4.5 bps taker per side on notional, slippage, and hourly funding on
   held positions.
3. The position sizing in live mode calls the SAME `calculatePortfolioAllocation` as the
   portfolio backtest (verified by test).
4. TESTNET mode, with a funded agent wallet, can: set leverage, place a market entry, place
   tp/sl trigger orders, read back the position from `getClearinghouseState`, and close it.
   Prices/sizes are rounded and accepted by the exchange.
5. `trader.enabled=false` (default) means the trader does nothing if accidentally started.
6. No code path can withdraw funds or trade on mainnet.
7. The testnet key is gitignored and never appears in a commit.
8. Dashboard shows live state, clearly labelled, without breaking existing views.

## Out of scope (do NOT do)

- Mainnet / real-money trading of any kind.
- Trading any interval other than 5m.
- Re-tuning the strategy or changing any tuning block.
- Auto-claiming faucet funds / approving the agent wallet in code (manual user setup; just
  document the steps).
- Fancy order types beyond market entry + tp/sl triggers (no TWAP, scaling, trailing stops).
- Multi-account or vault trading.

## Manual user setup to document in the plan (not code)

1. Create/approve an **agent (API) wallet** on Hyperliquid testnet for the trading address.
2. Deposit on mainnet once with the same address, then claim testnet USDC from the faucet.
3. Put the agent key in `trader.secret.ts` (gitignored).
4. Set `trader.enabled=true`, start in `PAPER`, watch it, then switch `mode` to `TESTNET`.
