import { config } from '../../config';
import { RegimeAwareStrategyEngine } from '../core/strategy';
import type { Candle, Levels, MarketEvent } from '../core/types';
import { TraderAccount } from './account';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation } from './sizing';

const FIVE = 5 * 60 * 1000;
const base = Date.UTC(2026, 5, 8, 12);

export async function runPaperDemo() {
  const account = new TraderAccount();
  const executor = new PaperExecutor();
  const engine = new RegimeAwareStrategyEngine();
  const events: MarketEvent[] = [];
  const candles = demoCandles();
  const levels = demoLevels();
  let opened = 0;
  let closed = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const update = engine.update({
      candle,
      levels,
      recentCandles: candles.slice(Math.max(0, index - 100), index + 1),
      recentEvents: events.slice(-200),
      regime: {
        candleCloseTime: candle.closeTime,
        ready: true,
        emaFast: 100,
        emaSlow: 100,
        atr: 2,
        rsi: 50,
        adx: 10,
        regime: 'RANGE',
      },
      options: {
        detection: {
          touchTolerance: config.tuning['5m'].touchTolerance,
          touchCooldownMinutes: config.tuning['5m'].touchCooldownMinutes,
        },
        rangeSignal: {
          confirmWithinCandles: config.tuning['5m'].confirmWithinCandles,
          stopBuffer: config.tuning['5m'].stopBuffer,
        },
        range: { ...config.tuning['5m'].range, minScore: 60 },
        trend: config.tuning['5m'].trend,
      },
    });
    events.push(...update.events, ...update.signals);

    for (const signal of update.signals) {
      const allocation = calculateLiveAllocation({
        equity: account.equity(),
        usedMargin: account.usedMargin(),
        entry: signal.entry,
        stop: signal.stop,
        direction: signal.direction,
      });
      if (allocation.status === 'REJECTED') continue;
      const result = await executor.openPosition({ signal, allocation, candle });
      if (result.position) {
        account.open(result.position);
        opened += 1;
        console.log(`[demo] opened ${signal.coin} ${signal.direction} entry=${result.position.entry.toFixed(4)} margin=${result.position.margin.toFixed(2)}`);
      }
    }

    for (const exit of update.exits) {
      const position = account.positions.get(exit.signal.coin);
      if (!position) continue;
      const result = await executor.closePosition({ position, exit, candle });
      if (result.closedTrade) {
        account.close(result.closedTrade);
        closed += 1;
        console.log(`[demo] closed ${position.coin} ${exit.reason} exit=${result.closedTrade.exitPrice.toFixed(4)} pnl=${result.closedTrade.pnl.toFixed(2)}`);
      }
    }
  }

  console.log(`[demo] PAPER 5m complete: opened=${opened} closed=${closed} equity=${account.equity().toFixed(2)}`);
}

function demoCandles(): Candle[] {
  const history = Array.from({ length: 45 }, (_, index) => candle(index, 100, 100.4, 99.8, 100.1));
  return [
    ...history,
    candle(45, 96, 96.5, 94.95, 95.5),
    candle(46, 95.6, 97, 95.1, 96.8),
    candle(47, 96.7, 97.2, 96.4, 97.1),
    candle(48, 97.1, 104, 97.0, 103.5),
  ];
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  const openTime = base + index * FIVE;
  return {
    openTime,
    closeTime: openTime + FIVE,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function demoLevels(): Levels {
  return {
    coin: 'ETH',
    computedAt: base,
    forUtcDay: '2026-06-08',
    rangeHigh: 110,
    rangeLow: 95,
    swingHigh: 120,
    swingLow: 80,
  };
}
