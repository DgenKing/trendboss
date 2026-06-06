import { assertValidConfig, config, tuningFor } from '../../config';
import { calculateIndicatorSeries, latestIndicatorAt } from '../core/indicators';
import { computeLevels } from '../core/levels';
import { RegimeAwareStrategyEngine } from '../core/strategy';
import type { Candle, Levels, MarketEvent } from '../core/types';
import { startApi } from './api';
import { fetchCandles, HyperliquidSocket } from './hyperliquid';
import { Store } from './store';
import { formatEvent, sendAlert } from './telegram';

const DAY_MS = 24 * 60 * 60 * 1000;

assertValidConfig();

const store = new Store(config.dbPath);
const status = {
  coins: [...config.coins],
  socketHealthy: false,
  prices: Object.fromEntries(config.coins.map((coin) => [coin, null])) as Record<string, number | null>,
};

const engines = new Map<string, RegimeAwareStrategyEngine>();
const activeLevels = new Map<string, Levels>();
let nextRestRequestAt = 0;
for (const coin of config.coins) {
  engines.set(coin, new RegimeAwareStrategyEngine());
}

// Start the API first so the dashboard can connect immediately while backfill runs.
startApi(store, status);

await backfillStartup();

scheduleUtcRolloverCheck();

const socket = new HyperliquidSocket(
  {
    wsUrl: config.wsUrl,
    coins: [...config.coins],
    intervals: [...config.chartIntervals],
    staleSocketSeconds: config.staleSocketSeconds,
  },
  {
    onClosedCandle: handleClosedCandle,
    onCurrentPrice: (coin, price) => {
      status.prices[coin] = price;
    },
    onHealth: (healthy) => {
      status.socketHealthy = healthy;
    },
    onLog: (message) => console.log(message),
  },
);

socket.start();

process.on('SIGINT', () => {
  socket.stop();
  store.close();
  process.exit(0);
});

async function backfillStartup() {
  const intervals = orderedChartIntervals();
  for (const interval of intervals) {
    for (const coin of config.coins) {
      try {
        await backfillInterval(coin, interval);
      } catch (error) {
        console.error(
          `Backfill failed for ${coin} ${interval}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  for (const coin of config.coins) {
    try {
      computeAndStoreLevels(coin);
    } catch (error) {
      console.error(`Level compute failed for ${coin}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function backfillInterval(coin: string, interval: string) {
  const endTime = Date.now();
  const intervalMs = intervalToMs(interval);
  const target = config.backfillTarget[interval] ?? 5000;
  const existingCount = store.countCandles(coin, interval);
  const lastCandleTime = store.getLastCandleTime(coin, interval);

  const startTime = existingCount < target || lastCandleTime === null
    ? endTime - target * intervalMs
    : Math.max(0, lastCandleTime - intervalMs);

  const estimatedCandles = Math.min(target + 1, Math.max(1, Math.ceil((endTime - startTime) / intervalMs)));
  await waitForRestBudget(estimatedCandles);

  const candles = await fetchCandles({
    restUrl: config.restUrl,
    coin,
    interval,
    startTime,
    endTime,
  });

  store.saveCandles(coin, interval, candles);
  console.log(
    `Backfilled ${coin} ${interval}: saved ${candles.length}, cached ${store.countCandles(coin, interval)}/${target}`,
  );
}

function computeAndStoreLevels(coin: string) {
  const t = tuningFor(config.tradeInterval);
  const dailyTarget = config.backfillTarget['1d'] ?? 5000;
  const dailyCandles = store.getRecentCandles(coin, '1d', dailyTarget);
  const levels = computeLevels(dailyCandles, {
    coin,
    swingLookbackDays: t.swingLookbackDays,
    pivotWindow: t.pivotWindow,
    swingMinDistancePct: t.swingMinDistancePct,
  });
  activeLevels.set(coin, levels);
  store.saveLevels(levels);

  console.log(`Levels for ${coin} ${levels.forUtcDay}:`, {
    rangeHigh: levels.rangeHigh,
    rangeLow: levels.rangeLow,
    swingHigh: levels.swingHigh,
    swingLow: levels.swingLow,
  });
}

async function handleClosedCandle(coin: string, interval: string, candle: Candle) {
  store.saveCandles(coin, interval, [candle]);

  if (interval === '1d') {
    try {
      computeAndStoreLevels(coin);
    } catch (error) {
      console.error(`Daily level recompute failed for ${coin}:`, error instanceof Error ? error.message : error);
    }
  }

  if (interval !== config.candleInterval) return;

  const levels = activeLevels.get(coin);
  if (!levels) return;
  const t = tuningFor(config.tradeInterval);

  // Trace the exact levels the engine compares against, so signals can be tied
  // to the same Levels the chart shows (single source of truth: activeLevels).
  const ts = new Date(candle.closeTime).toISOString().slice(5, 16);
  console.log(`[eval] ${coin} ${ts} close=${candle.close} | rangeHigh=${levels.rangeHigh} rangeLow=${levels.rangeLow} swingHigh=${levels.swingHigh} swingLow=${levels.swingLow}`);

  const recentCandles = store.getRecentCandles(coin, config.candleInterval, 100);
  const regimeCandles = store.getRecentCandles(coin, config.regimeInterval, 100);
  const recentEvents = store.getRecentEvents(coin, 200);
  const regime = latestIndicatorAt(
    calculateIndicatorSeries(regimeCandles, t.regime),
    candle.closeTime,
  );
  const engine = engines.get(coin);
  if (!engine) return;
  const update = engine.update({
    candle,
    levels,
    recentCandles,
    recentEvents,
    regime,
    options: {
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
  });

  console.log(`[regime] ${coin} ${regime?.ready ? regime.regime : 'WARMUP'} ADX=${regime?.adx.toFixed(1) ?? '--'} RSI=${regime?.rsi.toFixed(1) ?? '--'} active=${update.hasActiveTrade}`);
  for (const exit of update.exits) {
    console.log(`[exit] ${coin} ${exit.signal.strategy} ${exit.signal.direction} ${exit.reason} at ${exit.exitPrice}`);
  }
  await persistAndNotify([...update.events, ...update.signals]);
}

async function persistAndNotify(events: MarketEvent[]) {
  if (events.length === 0) return;

  const saved = store.saveEvents(events);
  for (const event of saved) {
    console.log(formatEvent(event));

    try {
      const delivered = await sendAlert(event, config.telegram);
      if (delivered && event.id) {
        store.markNotified(event.id);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

function scheduleUtcRolloverCheck() {
  const levelDays = new Map<string, string | undefined>();
  for (const [coin, levels] of activeLevels) {
    levelDays.set(coin, levels.forUtcDay);
  }

  setInterval(() => {
    const latestCompletedDay = latestCompletedUtcDay();
    for (const coin of config.coins) {
      if (levelDays.get(coin) !== latestCompletedDay) {
        void backfillInterval(coin, '1d')
          .then(() => computeAndStoreLevels(coin))
          .then(() => {
            levelDays.set(coin, activeLevels.get(coin)?.forUtcDay);
          })
          .catch((error) => {
            console.error(`Rollover recompute failed for ${coin}:`, error instanceof Error ? error.message : error);
          });
      }
    }
  }, 60_000);
}

function latestCompletedUtcDay() {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
}

function orderedChartIntervals(): string[] {
  return [
    config.candleInterval,
    ...config.chartIntervals.filter((interval) => interval !== config.candleInterval),
  ];
}

async function waitForRestBudget(estimatedCandles: number) {
  const estimatedWeight = 20 + Math.ceil(estimatedCandles / 60);
  const budgetSpacingMs = Math.ceil((estimatedWeight / config.backfillWeightBudgetPerMin) * 60_000);
  const spacingMs = Math.max(config.backfillRequestSpacingMs, budgetSpacingMs);
  const now = Date.now();
  const waitMs = Math.max(0, nextRestRequestAt - now);
  nextRestRequestAt = Math.max(now, nextRestRequestAt) + spacingMs;

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intervalToMs(interval: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(interval);
  if (!match) throw new Error(`Unsupported interval: ${interval}`);

  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return value * DAY_MS;
}
