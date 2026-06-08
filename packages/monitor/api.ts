import { config, tuningFor, type TradeInterval } from '../../config';
import { runBacktest, type BacktestResult } from '../core/backtest';
import { runPortfolioBacktest, type PortfolioResult } from '../core/portfolio';
import { TraderStore } from '../trader/store';
import type { Store } from './store';

export type MonitorStatus = {
  coins: string[];
  socketHealthy: boolean;
  prices: Record<string, number | null>;
};

export function startApi(store: Store, status: MonitorStatus) {
  const portfolioCache = createIntervalResultCache<PortfolioResult>();
  const backtestCache = new Map<string, IntervalCacheEntry<BacktestResult>>();
  let liveStore: TraderStore | null = null;
  const resolveCoin = (url: URL): string => {
    const requested = url.searchParams.get('coin');
    if (requested) {
      const match = status.coins.find((coin) => coin.toLowerCase() === requested.toLowerCase());
      if (match) return match;
    }
    return status.coins[0];
  };

  const resolveInterval = (url: URL): string => {
    const requested = url.searchParams.get('interval');
    if (requested) {
      const match = config.chartIntervals.find((interval) => interval === requested);
      if (match) return match;
    }
    return config.candleInterval;
  };

  const server = Bun.serve({
    port: config.apiPort,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return json({});
      }

      if (url.pathname === '/') {
        return html(apiIndex(status));
      }

      if (url.pathname === '/api/coins') {
        return json(status.coins);
      }

      if (url.pathname === '/api/intervals') {
        return json(config.chartIntervals);
      }

      if (url.pathname === '/api/trade-intervals') {
        return json(config.tradeIntervals);
      }

      if (url.pathname === '/api/portfolio') {
        const interval = resolveTradeInterval(url);
        if (!interval) return invalidInterval();
        const result = getCachedIntervalResult(
          portfolioCache,
          interval,
          config.portfolio.cacheMs,
          () => buildPortfolio(store, status.coins, interval),
        );
        return json(compactPortfolio(result));
      }

      if (url.pathname === '/api/backtest') {
        const interval = resolveTradeInterval(url);
        if (!interval) return invalidInterval();
        const coin = resolveCoin(url);
        const result = getCachedIntervalResult(
          backtestCache,
          `${coin}:${interval}`,
          config.portfolio.cacheMs,
          () => buildBacktest(store, coin, interval),
        );
        return json(result);
      }

      if (url.pathname === '/api/live') {
        liveStore ??= new TraderStore();
        return json(liveStore.getLiveState());
      }

      if (url.pathname === '/api/levels') {
        return json(store.getLatestLevels(resolveCoin(url)));
      }

      if (url.pathname === '/api/candles') {
        const interval = resolveInterval(url);
        const limit = Number(url.searchParams.get('limit') ?? 1500);
        return json(store.getRecentCandles(resolveCoin(url), interval, clampLimit(limit, 1, 5000)));
      }

      if (url.pathname === '/api/events') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return json(store.getRecentEvents(resolveCoin(url), clampLimit(limit, 1, 200)));
      }

      if (url.pathname === '/api/status') {
        const coin = resolveCoin(url);
        return json({
          coin,
          coins: status.coins,
          lastCandleTime: store.getLastCandleTime(coin, config.candleInterval),
          socketHealthy: status.socketHealthy,
          currentPrice: status.prices[coin] ?? null,
        });
      }

      return json({ error: 'Not found' }, 404);
    },
  });

  console.log(`Monitor API listening on http://localhost:${server.port}`);
  return server;
}

export type IntervalCacheEntry<T> = { computedAt: number; result: T };

export function createIntervalResultCache<T>() {
  return new Map<string, IntervalCacheEntry<T>>();
}

export function getCachedIntervalResult<T>(
  cache: Map<string, IntervalCacheEntry<T>>,
  interval: string,
  cacheMs: number,
  build: () => T,
): T {
  const cached = cache.get(interval);
  if (cached && Date.now() - cached.computedAt < cacheMs) {
    return cached.result;
  }

  const result = build();
  cache.set(interval, { computedAt: Date.now(), result });
  return result;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function invalidInterval() {
  return json({
    error: `Invalid interval. Use one of: ${config.tradeIntervals.join(', ')}`,
  }, 400);
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function apiIndex(status: MonitorStatus) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hyperliquid Monitor API</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #efeee9;
        color: #15171a;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      main {
        width: min(720px, calc(100vw - 40px));
        border: 1px solid #dedbd2;
        background: #fbfaf6;
        padding: 28px;
      }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 0 0 20px; color: #62666a; }
      a {
        color: #15171a;
        font-weight: 650;
        text-decoration-thickness: 2px;
        text-underline-offset: 3px;
      }
      ul { margin: 18px 0 0; padding-left: 20px; line-height: 1.9; }
      code {
        background: #efeee9;
        border: 1px solid #dedbd2;
        padding: 2px 6px;
      }
      .status {
        display: inline-block;
        margin-top: 4px;
        padding: 6px 10px;
        border: 1px solid ${status.socketHealthy ? '#20885f' : '#b94040'};
        color: ${status.socketHealthy ? '#20885f' : '#b94040'};
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Hyperliquid Monitor API</h1>
      <p>This port serves JSON for the dashboard. Open the dashboard at <a href="http://localhost:3000">localhost:3000</a>.</p>
      <div class="status">socket ${status.socketHealthy ? 'healthy' : 'offline'} - ${status.coins.length} coins: ${status.coins.join(', ')}</div>
      <ul>
        <li><a href="/api/coins"><code>/api/coins</code></a></li>
        <li><a href="/api/intervals"><code>/api/intervals</code></a></li>
        <li><a href="/api/trade-intervals"><code>/api/trade-intervals</code></a></li>
        <li><a href="/api/portfolio"><code>/api/portfolio</code></a></li>
        <li><a href="/api/backtest?coin=${encodeURIComponent(status.coins[0] ?? '')}&interval=15m"><code>/api/backtest?coin=…&interval=15m</code></a></li>
        <li><a href="/api/live"><code>/api/live</code></a></li>
        <li><a href="/api/status?coin=${encodeURIComponent(status.coins[0] ?? '')}"><code>/api/status?coin=…</code></a></li>
        <li><a href="/api/levels?coin=${encodeURIComponent(status.coins[0] ?? '')}"><code>/api/levels?coin=…</code></a></li>
        <li><a href="/api/candles?coin=${encodeURIComponent(status.coins[0] ?? '')}&interval=15m&limit=1500"><code>/api/candles?coin=…&interval=15m&limit=1500</code></a></li>
        <li><a href="/api/events?coin=${encodeURIComponent(status.coins[0] ?? '')}&limit=50"><code>/api/events?coin=…&limit=50</code></a></li>
      </ul>
    </main>
  </body>
</html>`;
}

function buildPortfolio(store: Store, coins: string[], tradeInterval: TradeInterval) {
  const t = tuningFor(tradeInterval);
  const regimeInterval = config.regimeForTrade[tradeInterval];
  const symbols = coins.map((coin) => ({
    coin,
    strategyCandles: store.getRecentCandles(coin, tradeInterval, config.backfillTarget[tradeInterval]),
    regimeCandles: store.getRecentCandles(coin, regimeInterval, config.backfillTarget[regimeInterval]),
    dailyCandles: store.getRecentCandles(coin, '1d', config.backfillTarget['1d']),
  }));

  return runPortfolioBacktest(symbols, {
    ...config.portfolio,
    ...config.backtest,
    regime: t.regime,
    tradeInterval,
    regimeInterval,
    backtest: {
      tradeInterval,
      regimeInterval,
      detection: {
        touchTolerance: t.touchTolerance,
        touchCooldownMinutes: t.touchCooldownMinutes,
      },
      strategy: {
        detection: {
          touchTolerance: t.touchTolerance,
          touchCooldownMinutes: t.touchCooldownMinutes,
        },
        rangeSignal: {
          confirmWithinCandles: t.confirmWithinCandles,
          stopBuffer: t.stopBuffer,
        },
        range: t.range,
        trend: t.trend,
      },
      regime: t.regime,
      feePerSide: config.backtest.feePerSide,
      slippagePerSide: config.backtest.slippagePerSide,
      swingLookbackDays: t.swingLookbackDays,
      pivotWindow: t.pivotWindow,
      swingMinDistancePct: t.swingMinDistancePct,
    },
  });
}

function buildBacktest(store: Store, coin: string, tradeInterval: TradeInterval) {
  const t = tuningFor(tradeInterval);
  const regimeInterval = config.regimeForTrade[tradeInterval];
  const strategyCandles = store.getRecentCandles(coin, tradeInterval, config.backfillTarget[tradeInterval]);
  const regimeCandles = store.getRecentCandles(coin, regimeInterval, config.backfillTarget[regimeInterval]);
  const dailyCandles = store.getRecentCandles(coin, '1d', config.backfillTarget['1d']);

  return runBacktest(strategyCandles, dailyCandles, {
    coin,
    tradeInterval,
    regimeInterval,
    detection: {
      touchTolerance: t.touchTolerance,
      touchCooldownMinutes: t.touchCooldownMinutes,
    },
    strategy: {
      detection: {
        touchTolerance: t.touchTolerance,
        touchCooldownMinutes: t.touchCooldownMinutes,
      },
      rangeSignal: {
        confirmWithinCandles: t.confirmWithinCandles,
        stopBuffer: t.stopBuffer,
      },
      range: t.range,
      trend: t.trend,
    },
    regime: t.regime,
    feePerSide: config.backtest.feePerSide,
    slippagePerSide: config.backtest.slippagePerSide,
    swingLookbackDays: t.swingLookbackDays,
    pivotWindow: t.pivotWindow,
    swingMinDistancePct: t.swingMinDistancePct,
  }, regimeCandles);
}

function compactPortfolio(result: PortfolioResult): PortfolioResult {
  const step = Math.max(1, Math.ceil(result.timeline.length / 1_200));
  const timeline = result.timeline.filter((_, index) => (
    index === 0 || index === result.timeline.length - 1 || index % step === 0
  ));
  return {
    ...result,
    timeline,
    closedTrades: result.closedTrades.slice(-100),
    decisions: result.decisions.slice(-200),
  };
}

function resolveTradeInterval(url: URL): TradeInterval | null {
  const requested = url.searchParams.get('interval') ?? config.tradeInterval;
  return config.tradeIntervals.includes(requested as TradeInterval) ? requested as TradeInterval : null;
}

function clampLimit(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
