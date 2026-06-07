import { describe, expect, test } from 'bun:test';
import { config, tuningFor, validateConfig } from '../../config';
import { createIntervalResultCache, getCachedIntervalResult } from '../monitor/api';
import { runBacktest } from './backtest';
import { ReversionSignalTracker, detectTouch } from './detect';
import { calculateIndicatorSeries, latestIndicatorAt, type IndicatorSnapshot } from './indicators';
import { computeLevels } from './levels';
import {
  calculatePortfolioAllocation,
  portfolioCommonStart,
  simulatePortfolioTrades,
  type PortfolioCandidateTrade,
} from './portfolio';
import { RegimeAwareStrategyEngine, type RegimeStrategyOptions } from './strategy';
import type { Candle, Levels, MarketEvent } from './types';

const DAY = 24 * 60 * 60 * 1000;
const FIFTEEN = 15 * 60 * 1000;
const now = Date.UTC(2026, 5, 3, 12);

function validConfigForValidation() {
  return {
    coins: ['ETH'],
    tradeInterval: '15m',
    tradeIntervals: ['5m', '15m', '1h', '2h', '4h'],
    regimeForTrade: {
      '5m': '1h',
      '15m': '1h',
      '1h': '4h',
      '2h': '4h',
      '4h': '1d',
    },
    candleInterval: '15m',
    regimeInterval: '1h',
    chartIntervals: ['5m', '15m', '1h', '2h', '4h', '1d'],
    backfillTarget: {
      '5m': 5000,
      '15m': 5000,
      '1h': 5000,
      '2h': 5000,
      '4h': 5000,
      '1d': 5000,
    },
  };
}

describe('trade interval config', () => {
  test('maps each trade interval to the intended regime interval', () => {
    expect(config.regimeForTrade).toEqual({
      '5m': '1h',
      '15m': '1h',
      '1h': '4h',
      '2h': '4h',
      '4h': '1d',
    });
    expect(config.candleInterval).toBe(config.tradeInterval);
    expect(config.regimeInterval).toBe(config.regimeForTrade[config.tradeInterval]);
  });

  test('returns tuning by trade interval', () => {
    for (const interval of config.tradeIntervals) {
      expect(tuningFor(interval)).toBe(config.tuning[interval]);
    }
  });

  test('keeps 5m tuning independent from 15m after tuning', () => {
    expect(config.tuning['5m']).not.toEqual(config.tuning['15m']);
  });

  test('rejects an unsupported trade interval', () => {
    expect(() => validateConfig({
      ...validConfigForValidation(),
      tradeInterval: '30m',
      candleInterval: '30m',
      regimeInterval: undefined,
    })).toThrow('Trade interval 30m');
  });

  test('keeps cached results isolated by interval', () => {
    const cache = createIntervalResultCache<number>();
    let builds = 0;

    const first15m = getCachedIntervalResult(cache, '15m', 60_000, () => {
      builds += 1;
      return builds;
    });
    const second15m = getCachedIntervalResult(cache, '15m', 60_000, () => {
      builds += 1;
      return builds;
    });
    const first4h = getCachedIntervalResult(cache, '4h', 60_000, () => {
      builds += 1;
      return builds;
    });

    expect(first15m).toBe(1);
    expect(second15m).toBe(1);
    expect(first4h).toBe(2);
    expect(builds).toBe(2);
  });
});

describe('computeLevels', () => {
  test('computes range and nearest swing pivots using completed UTC daily candles', () => {
    const candles = dailyFixture([
      [100, 80],
      [110, 84],
      [108, 82],
      [130, 81],
      [112, 83],
      [109, 78],
      [115, 86],
      [111, 85],
      [107, 79],
      [105, 90],
    ]);

    const levels = computeLevels(candles, {
      coin: 'ETH',
      now,
      swingLookbackDays: 90,
      pivotWindow: 2,
    });

    expect(levels.forUtcDay).toBe('2026-06-02');
    expect(levels.rangeHigh).toBe(105);
    expect(levels.rangeLow).toBe(90);
    expect(levels.swingHigh).toBe(115);
    expect(levels.swingLow).toBe(78);
  });

  test('rejects a swing that is not at least swingMinDistancePct beyond the range', () => {
    // Mirrors the HYPE-at-ATH case: the nearest pivot high is barely above the
    // range high (fake precision) so swingHigh must be null; the swing low sits
    // well below the range low and survives.
    const candles = dailyFixture([
      [99, 96],
      [99, 94],
      [98, 70],     // pivot low 70, well below range low -> valid swingLow
      [99, 94],
      [100.3, 92],  // pivot high 100.3, only 0.3% above range high -> rejected
      [99, 96],
      [98, 97],
      [100, 95],    // yesterday: rangeHigh 100, rangeLow 95
    ]);

    const levels = computeLevels(candles, {
      coin: 'ETH',
      now,
      swingLookbackDays: 0,
      pivotWindow: 2,
      swingMinDistancePct: 0.015,
    });

    expect(levels.rangeHigh).toBe(100);
    expect(levels.swingHigh).toBeNull();
    expect(levels.swingLow).toBe(70);
  });

  test('returns null for missing swing levels inside the lookback', () => {
    const candles = dailyFixture([
      [100, 90],
      [101, 91],
      [102, 92],
      [103, 93],
      [104, 94],
      [105, 95],
    ]);

    const levels = computeLevels(candles, {
      coin: 'SOL',
      now,
      swingLookbackDays: 90,
      pivotWindow: 2,
    });

    expect(levels.rangeHigh).toBe(105);
    expect(levels.rangeLow).toBe(95);
    expect(levels.swingHigh).toBeNull();
    expect(levels.swingLow).toBeNull();
  });
});

describe('detectTouch', () => {
  test('emits a support touch when price rejects and closes back above the level', () => {
    const [event] = detectTouch(
      candle(0, 100, 101, 94.95, 95.4),
      testLevels(),
      { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
    );

    expect(event.type).toBe('LEVEL_TOUCH');
    expect(event.side).toBe('SUPPORT');
    expect(event.levelName).toBe('rangeLow');
  });

  test('emits a break when close moves through a support level', () => {
    const [event] = detectTouch(
      candle(0, 96, 97, 94, 94.8),
      testLevels(),
      { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
    );

    expect(event.type).toBe('LEVEL_BREAK');
    expect(event.side).toBe('SUPPORT');
  });

  test('suppresses duplicate touch events inside the cooldown window', () => {
    const recent: MarketEvent[] = [{
      type: 'LEVEL_TOUCH',
      coin: 'ETH',
      side: 'SUPPORT',
      levelName: 'rangeLow',
      levelPrice: 95,
      candleCloseTime: candle(1, 96, 97, 94.95, 95.5).closeTime,
      price: 95.5,
      notified: true,
    }];

    const events = detectTouch(
      candle(2, 100, 101, 94.95, 95.4),
      testLevels(),
      { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
      recent,
    );

    expect(events).toHaveLength(0);
  });
});

describe('ReversionSignalTracker', () => {
  test('emits a confirmed long signal after support touch, confirmation, and trigger', () => {
    const tracker = new ReversionSignalTracker();
    const levels = testLevels();
    const history = Array.from({ length: 10 }, (_, index) => candle(index, 100, 100.4, 99.8, 100.1));

    const candleA = candle(10, 96, 96.5, 94.95, 95.5);
    const touches = detectTouch(candleA, levels, { touchTolerance: 0.0008, touchCooldownMinutes: 60 });
    expect(touches[0].type).toBe('LEVEL_TOUCH');
    expect(tracker.update(candleA, levels, touches, history, signalOptions())).toHaveLength(0);

    const candleB = candle(11, 95.6, 97, 95.1, 96.8);
    expect(tracker.update(candleB, levels, [], [...history, candleA], signalOptions())).toHaveLength(0);

    const candleC = candle(12, 96.7, 97.2, 96.4, 97.1);
    const [signal] = tracker.update(candleC, levels, [], [...history, candleA, candleB], signalOptions());

    expect(signal.type).toBe('CONFIRMED_SIGNAL');
    expect(signal.direction).toBe('LONG');
    expect(signal.entry).toBe(97);
    expect(signal.target).toBe(110);
    expect(signal.score).toBeGreaterThanOrEqual(60);
  });

  test('invalidates a setup when no confirmation appears within the configured window', () => {
    const tracker = new ReversionSignalTracker();
    const levels = testLevels();
    const candleA = candle(20, 96, 96.5, 94.95, 95.5);
    const touches = detectTouch(candleA, levels, { touchTolerance: 0.0008, touchCooldownMinutes: 60 });

    tracker.update(candleA, levels, touches, [], signalOptions());
    tracker.update(candle(21, 96, 96.2, 94.8, 95.9), levels, [], [], signalOptions());
    tracker.update(candle(22, 95.9, 96, 94.7, 95.8), levels, [], [], signalOptions());
    tracker.update(candle(23, 95.8, 96, 94.6, 95.7), levels, [], [], signalOptions());

    const events = tracker.update(candle(24, 95.7, 97, 95.1, 96.8), levels, [], [], signalOptions());
    expect(events).toHaveLength(0);
  });
});

describe('runBacktest', () => {
  test('simulates a confirmed long trade from the first available strategy candle', () => {
    const dailyCandles = dailyFixture([
      [100, 80],
      [110, 84],
      [108, 82],
      [130, 81],
      [112, 83],
      [109, 78],
      [115, 86],
      [111, 85],
      [107, 88],
      [110, 95],
    ]);
    const strategyCandles = [
      candle(0, 100, 100.4, 99.8, 100.1),
      candle(1, 96, 96.5, 94.95, 95.5),
      candle(2, 95.6, 97, 95.1, 96.8),
      candle(3, 96.7, 97.2, 96.4, 97.1),
      candle(4, 97.2, 110.5, 97, 110.2),
    ];

    const result = runBacktest(strategyCandles, dailyCandles, {
      coin: 'ETH',
      detection: { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
      signal: signalOptions(),
    });

    expect(result.firstCandleTime).toBe(strategyCandles[0].openTime);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].direction).toBe('LONG');
    expect(result.trades[0].entry).toBe(97);
    expect(result.trades[0].exitReason).toBe('TARGET');
    expect(result.trades[0].exitPrice).toBe(110);
    expect(result.summary.closedTrades).toBe(1);
    expect(result.summary.wins).toBe(1);
    expect(result.summary.netR).toBeGreaterThan(6);
  });

  test('recomputes historical daily levels instead of using a single current snapshot', () => {
    const dailyCandles = dailyFixture([
      [100, 80],
      [110, 84],
      [108, 82],
      [130, 81],
      [112, 83],
      [109, 78],
      [115, 86],
      [111, 85],
      [107, 88],
      [110, 95],
      [140, 100],
    ]);
    const strategyCandles = [
      candle(0, 100, 100.4, 99.8, 100.1),
      candle(1, 96, 96.5, 94.95, 95.5),
      candle(2, 95.6, 97, 95.1, 96.8),
      candle(3, 96.7, 97.2, 96.4, 97.1),
      candle(4, 97.2, 110.5, 97, 110.2),
    ];

    const result = runBacktest(strategyCandles, dailyCandles, {
      coin: 'ETH',
      detection: { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
      signal: signalOptions(),
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].target).toBe(110);
  });

  test('deducts trading friction and reports evidence metrics', () => {
    const dailyCandles = dailyFixture([
      [100, 80], [110, 84], [108, 82], [130, 81], [112, 83],
      [109, 78], [115, 86], [111, 85], [107, 88], [110, 95],
    ]);
    const strategyCandles = [
      candle(0, 100, 100.4, 99.8, 100.1),
      candle(1, 96, 96.5, 94.95, 95.5),
      candle(2, 95.6, 97, 95.1, 96.8),
      candle(3, 96.7, 97.2, 96.4, 97.1),
      candle(4, 97.2, 110.5, 97, 110.2),
    ];
    const base = {
      coin: 'ETH',
      detection: { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
      signal: signalOptions(),
    };

    const frictionless = runBacktest(strategyCandles, dailyCandles, base);
    const realistic = runBacktest(strategyCandles, dailyCandles, {
      ...base,
      feePerSide: 0.00035,
      slippagePerSide: 0.00015,
    });

    expect(realistic.summary.netR).toBeLessThan(frictionless.summary.netR);
    expect(realistic.summary.profitFactor).toBeGreaterThan(1);
    expect(realistic.summary.maxDrawdownR).toBe(0);
    expect(realistic.segments.outOfSample.label).toBe('Last 30%');
  });
});

describe('regime-aware strategy', () => {
  test('classifies sustained directional hourly markets and flat markets', () => {
    const rising = hourlyTrend(100, 1);
    const falling = hourlyTrend(200, -1);
    const flat = hourlyTrend(100, 0);

    expect(calculateIndicatorSeries(rising).at(-1)?.regime).toBe('UPTREND');
    expect(calculateIndicatorSeries(falling).at(-1)?.regime).toBe('DOWNTREND');
    expect(calculateIndicatorSeries(flat).at(-1)?.regime).toBe('RANGE');
  });

  test('uses only an already-closed hourly regime candle', () => {
    const series = calculateIndicatorSeries(hourlyTrend(100, 1));
    const target = series[80];

    expect(latestIndicatorAt(series, target.candleCloseTime - 1)?.candleCloseTime)
      .toBe(series[79].candleCloseTime);
    expect(latestIndicatorAt(series, target.candleCloseTime)?.candleCloseTime)
      .toBe(target.candleCloseTime);
  });

  test('suppresses range-reversion entries outside range regime', () => {
    const engine = new RegimeAwareStrategyEngine();
    const history = Array.from({ length: 45 }, (_, index) => candle(index, 100, 100.4, 99.8, 100.1));
    const touch = candle(45, 96, 96.5, 94.95, 95.5);
    const confirmation = candle(46, 95.6, 97, 95.1, 96.8);
    const trigger = candle(47, 96.7, 97.2, 96.4, 97.1);
    const options = strategyOptions();
    const regime = indicator('UPTREND');

    expect(engine.update({
      candle: touch,
      levels: testLevels(),
      recentCandles: [...history, touch],
      recentEvents: [],
      regime,
      options,
    }).signals).toHaveLength(0);
    expect(engine.update({
      candle: confirmation,
      levels: testLevels(),
      recentCandles: [...history, touch, confirmation],
      recentEvents: [],
      regime,
      options,
    }).signals).toHaveLength(0);
    expect(engine.update({
      candle: trigger,
      levels: testLevels(),
      recentCandles: [...history, touch, confirmation, trigger],
      recentEvents: [],
      regime,
      options,
    }).signals).toHaveLength(0);
  });

  test('requires a quiet high-score range and caps its target', () => {
    const history = Array.from({ length: 45 }, (_, index) => candle(index, 100, 100.4, 99.8, 100.1));
    const touch = candle(45, 96, 96.5, 94.95, 95.5);
    const confirmation = candle(46, 95.6, 97, 95.1, 96.8);
    const trigger = candle(47, 96.7, 97.2, 96.4, 97.1);
    const options = strategyOptions();
    options.range = { enabled: true, maxAdx: 12, targetR: 2, minScore: 80 };

    const engine = new RegimeAwareStrategyEngine();
    const quietRange = { ...indicator('RANGE'), adx: 10 };
    engine.update({ candle: touch, levels: testLevels(), recentCandles: [...history, touch], recentEvents: [], regime: quietRange, options });
    engine.update({ candle: confirmation, levels: testLevels(), recentCandles: [...history, touch, confirmation], recentEvents: [], regime: quietRange, options });
    const update = engine.update({ candle: trigger, levels: testLevels(), recentCandles: [...history, touch, confirmation, trigger], recentEvents: [], regime: quietRange, options });

    expect(update.signals).toHaveLength(1);
    expect(update.signals[0].target).toBeCloseTo(101.19495);
  });

  test('enters a trend breakout on the next candle and blocks overlapping entries', () => {
    const engine = new RegimeAwareStrategyEngine();
    const history = Array.from({ length: 45 }, (_, index) => (
      candle(index, 100 + index * 0.1, 100.5 + index * 0.1, 99.7 + index * 0.1, 100.3 + index * 0.1)
    ));
    const breakout = candle(45, 105, 108, 104.8, 107.8);
    const entryCandle = candle(46, 108, 108.5, 107.5, 108.2);
    const anotherBreakout = candle(47, 108.2, 110, 108, 109.8);
    const options = strategyOptions();
    const regime = indicator('UPTREND');

    const setup = engine.update({
      candle: breakout,
      levels: testLevels(),
      recentCandles: [...history, breakout],
      recentEvents: [],
      regime,
      options,
    });
    expect(setup.signals).toHaveLength(0);

    const entry = engine.update({
      candle: entryCandle,
      levels: testLevels(),
      recentCandles: [...history, breakout, entryCandle],
      recentEvents: [],
      regime,
      options,
    });
    expect(entry.signals).toHaveLength(1);
    expect(entry.signals[0].strategy).toBe('TREND_MOMENTUM');
    expect(entry.signals[0].direction).toBe('LONG');

    const blocked = engine.update({
      candle: anotherBreakout,
      levels: testLevels(),
      recentCandles: [...history, breakout, entryCandle, anotherBreakout],
      recentEvents: [],
      regime,
      options,
    });
    expect(blocked.signals).toHaveLength(0);
    expect(blocked.hasActiveTrade).toBe(true);
  });

  test('cancels a queued trend breakout when the regime flips before entry', () => {
    const engine = new RegimeAwareStrategyEngine();
    const history = Array.from({ length: 45 }, (_, index) => (
      candle(index, 100 + index, 101 + index, 99 + index, 100.8 + index)
    ));
    const breakout = candle(45, 145, 151, 144, 150);
    const options = strategyOptions();

    engine.update({
      candle: breakout,
      levels: testLevels(),
      recentCandles: [...history, breakout],
      recentEvents: [],
      regime: indicator('UPTREND'),
      options,
    });
    const cancelled = engine.update({
      candle: candle(46, 150, 151, 148, 149),
      levels: testLevels(),
      recentCandles: [...history, breakout, candle(46, 150, 151, 148, 149)],
      recentEvents: [],
      regime: indicator('RANGE'),
      options,
    });

    expect(cancelled.signals).toHaveLength(0);
    expect(cancelled.hasActiveTrade).toBe(false);
  });
});

describe('shared-capital portfolio', () => {
  test('targets 2% equity risk with 5x leverage and caps margin at 25%', () => {
    const sized = calculatePortfolioAllocation({
      equity: 1_000,
      usedMargin: 0,
      entry: 100,
      stop: 90,
      direction: 'LONG',
      leverage: 5,
      riskPerTrade: 0.02,
      maxPositionMargin: 0.25,
      maxTotalMargin: 1,
      feePerSide: 0,
      slippagePerSide: 0,
    });
    const capped = calculatePortfolioAllocation({
      equity: 1_000,
      usedMargin: 0,
      entry: 100,
      stop: 99,
      direction: 'LONG',
      leverage: 5,
      riskPerTrade: 0.02,
      maxPositionMargin: 0.25,
      maxTotalMargin: 1,
      feePerSide: 0,
      slippagePerSide: 0,
    });

    expect(sized.margin).toBeCloseTo(40);
    expect(sized.notional).toBeCloseTo(200);
    expect(sized.allocationPct).toBeCloseTo(0.04);
    expect(capped.margin).toBeCloseTo(250);
    expect(capped.notional).toBeCloseTo(1_250);
  });

  test('partially sizes against remaining portfolio margin', () => {
    const allocation = calculatePortfolioAllocation({
      equity: 1_000,
      usedMargin: 900,
      entry: 100,
      stop: 99,
      direction: 'LONG',
      leverage: 5,
      riskPerTrade: 0.02,
      maxPositionMargin: 0.25,
      maxTotalMargin: 1,
      feePerSide: 0,
      slippagePerSide: 0,
    });

    expect(allocation.margin).toBeCloseTo(100);
    expect(allocation.notional).toBeCloseTo(500);
    expect(allocation.status).toBe('PARTIAL');
  });

  test('prioritizes higher scores when simultaneous signals compete for margin', () => {
    const result = simulatePortfolioTrades(
      [
        portfolioTrade('LOW', 60, 'LONG', 100, 99, 102, 0.02),
        portfolioTrade('HIGH', 100, 'LONG', 100, 99, 102, 0.02),
      ],
      {
        LOW: [candle(0, 100, 102, 99, 101)],
        HIGH: [candle(0, 100, 102, 99, 101)],
      },
      portfolioOptions({ maxPositionMargin: 1, maxTotalMargin: 0.4 }),
      candle(0, 100, 102, 99, 101).closeTime,
      candle(0, 100, 102, 99, 101).closeTime,
    );

    expect(result.decisions[0].coin).toBe('HIGH');
    expect(result.decisions[0].status).toBe('ACCEPTED');
    expect(result.decisions[1].coin).toBe('LOW');
    expect(result.decisions[1].status).toBe('REJECTED');
  });

  test('closes isolated positions when margin is exhausted before the stop', () => {
    const entryCandle = candle(0, 100, 101, 99, 100);
    const liquidationCandle = candle(1, 100, 101, 79, 82);
    const result = simulatePortfolioTrades(
      [portfolioTrade('ETH', 100, 'LONG', 100, 70, 130, -0.3, liquidationCandle.closeTime)],
      { ETH: [entryCandle, liquidationCandle] },
      portfolioOptions({ maxPositionMargin: 0.25 }),
      entryCandle.closeTime,
      liquidationCandle.closeTime,
    );

    expect(result.summary.liquidations).toBe(1);
    expect(result.closedTrades[0].exitReason).toBe('LIQUIDATION');
    expect(result.summary.finalEquity).toBeLessThan(1_000);
  });

  test('chooses the first timestamp where every symbol has ready data', () => {
    const start = portfolioCommonStart([
      {
        coin: 'A',
        strategyCandles: [candle(0, 1, 1, 1, 1)],
        regimeCandles: hourlyTrend(100, 1),
        dailyCandles: dailyFixture([[2, 1]]),
      },
      {
        coin: 'B',
        strategyCandles: [candle(4, 1, 1, 1, 1)],
        regimeCandles: hourlyTrend(100, 1).map((item) => ({
          ...item,
          openTime: item.openTime + FIFTEEN,
          closeTime: item.closeTime + FIFTEEN,
        })),
        dailyCandles: dailyFixture([[2, 1]]),
      },
    ]);

    expect(start).toBeGreaterThan(candle(4, 1, 1, 1, 1).openTime);
  });
});

function dailyFixture(values: Array<[high: number, low: number]>): Candle[] {
  const firstOpen = Date.UTC(2026, 4, 24);
  return values.map(([high, low], index) => ({
    openTime: firstOpen + index * DAY,
    closeTime: firstOpen + (index + 1) * DAY,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
  }));
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  const openTime = Date.UTC(2026, 5, 3) + index * FIFTEEN;
  return {
    openTime,
    closeTime: openTime + FIFTEEN,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function testLevels(): Levels {
  return {
    coin: 'ETH',
    computedAt: now,
    forUtcDay: '2026-06-02',
    rangeHigh: 110,
    rangeLow: 95,
    swingHigh: 120,
    swingLow: 80,
  };
}

function signalOptions() {
  return {
    confirmWithinCandles: 3,
    stopBuffer: 0.0005,
  };
}

function strategyOptions(): RegimeStrategyOptions {
  return {
    detection: { touchTolerance: 0.0008, touchCooldownMinutes: 60 },
    rangeSignal: signalOptions(),
    range: { enabled: true, maxAdx: 18, targetR: 2, minScore: 60 },
    trend: {
      breakoutLookback: 40,
      atrPeriod: 14,
      atrStopMultiple: 2,
      targetR: 3,
      rsiPeriod: 14,
      rsiLongMin: 55,
      rsiShortMax: 45,
    },
  };
}

function indicator(regime: IndicatorSnapshot['regime']): IndicatorSnapshot {
  return {
    candleCloseTime: now,
    ready: true,
    emaFast: regime === 'UPTREND' ? 110 : 90,
    emaSlow: 100,
    atr: 2,
    rsi: regime === 'DOWNTREND' ? 40 : 60,
    adx: regime === 'RANGE' ? 15 : 30,
    regime,
  };
}

function hourlyTrend(start: number, step: number): Candle[] {
  const hour = 60 * 60 * 1000;
  return Array.from({ length: 100 }, (_, index) => {
    const close = start + index * step;
    const openTime = Date.UTC(2026, 0, 1) + index * hour;
    return {
      openTime,
      closeTime: openTime + hour,
      open: close - step * 0.5,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 100,
    };
  });
}

function portfolioOptions(overrides: Partial<Parameters<typeof simulatePortfolioTrades>[2]> = {}) {
  return {
    startingCapital: 1_000,
    leverage: 5,
    riskPerTrade: 0.02,
    maxPositionMargin: 0.25,
    maxTotalMargin: 1,
    feePerSide: 0,
    slippagePerSide: 0,
    ...overrides,
  };
}

function portfolioTrade(
  coin: string,
  score: number,
  direction: 'LONG' | 'SHORT',
  entry: number,
  stop: number,
  exitPrice: number,
  returnPct: number,
  exitTime = candle(0, entry, entry, entry, entry).closeTime,
): PortfolioCandidateTrade {
  const signalTime = candle(0, entry, entry, entry, entry).closeTime;
  return {
    coin,
    direction,
    strategy: 'TREND_MOMENTUM',
    regime: direction === 'LONG' ? 'UPTREND' : 'DOWNTREND',
    levelName: direction === 'LONG' ? 'trendBreakoutHigh' : 'trendBreakoutLow',
    levelPrice: entry,
    signalTime,
    entry,
    stop,
    target: exitPrice,
    exitTime,
    exitPrice,
    exitReason: 'TARGET',
    rMultiple: 1,
    returnPct,
    durationCandles: 1,
    score,
  };
}
