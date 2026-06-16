# Paper + Testnet Trader Setup

Date: 2026-06-08

The trader is a separate process from the monitor:

```sh
bun run trader
```

Defaults are safe: `config.trader.enabled` is `false`, mode is `PAPER`, and the only supported
trade interval is `5m`.

## Paper Mode

Paper mode needs no private key and sends no orders. To run it:

```sh
TRADER_ENABLED=true TRADER_MODE=PAPER bun run trader
```

Paper fills use the same fee and slippage assumptions as the backtest: 1.5 bps slippage and
3.5 bps fee per side. Backtests enter at the next candle open; live signals arrive when candle
N closes, so paper/testnet entries are submitted immediately after that close, approximately
the next candle open.

For a deterministic local smoke test:

```sh
bun run trader --demo-paper
```

## Hyperliquid Testnet

TESTNET mode places real signed orders on Hyperliquid testnet with fake testnet funds only.
There is no mainnet mode and no withdrawal code path.

Manual setup:

1. Create or approve an agent/API wallet for the Hyperliquid account you want to test.
2. Deposit once on mainnet with the same address, then claim mock USDC from
   `https://app.hyperliquid-testnet.xyz/drip`.
3. Create a local, gitignored `trader.secret.ts` at the repo root:

```ts
export const TESTNET_AGENT_KEY = '0x...';
export const TESTNET_ACCOUNT_ADDRESS = '0x...';
```

`TESTNET_ACCOUNT_ADDRESS` is the actual trading account/master address required by the
`nomeida/hyperliquid` SDK when signing with an agent wallet.

4. Confirm `config.trader.coins` contains only plain Hyperliquid perp symbols for TESTNET
   in this first version. HIP-3 `dex:ASSET` markets are refused by the TESTNET executor.
5. Start TESTNET explicitly:

```sh
TRADER_ENABLED=true TRADER_MODE=TESTNET bun run trader
```

The TESTNET executor uses `testnet: true`, isolated 5x leverage, IOC entry orders, and
reduce-only TP/SL trigger orders with `normalTpsl`. If any order is rejected or account state
does not reconcile, it logs the exchange response and does not retry blindly.
