# TrendBoss Operator Guide

TrendBoss is a single-purpose Hyperliquid **TESTNET** live trading app. It trades the shared
5-minute strategy across BTC, ETH, SOL, BNB, HYPE, NEAR, WLD, TON, SUI, and DOGE.

Start web, API, and trader together with:

```bash
bun run start
```

- Web panel: `http://localhost:3000`
- Health JSON: `http://localhost:8787/health`
- Event log: `logs/events.TESTNET.jsonl`
- Health snapshot: `logs/status.json`
- Candle database: `data/monitor.db`
- Live trade database: `data/testnet.db`

No-confusion rule: if data did not come from the live TESTNET trader, it does not appear in
the running app. There is no PAPER, backtest, portfolio, replay, or timeframe-selector view.
