import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { calculatePortfolioAllocation } from '../core/portfolio';
import type { StrategyExit, StrategySignal } from '../core/strategy';
import type { Candle } from '../core/types';
import { main } from './index';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation, liveAllocationCalculator } from './sizing';
import { formatPrice, formatSize, loadTestnetSecret } from './testnet';

describe('trader config safety', () => {
  test('enabled:false is a no-op', async () => {
    expect(config.trader.enabled).toBe(false);
    await expect(main()).resolves.toBeUndefined();
  });

  test('TESTNET refuses to start without the gitignored secret', async () => {
    await expect(loadTestnetSecret()).rejects.toThrow('trader.secret.ts');
  });
});

describe('live sizing', () => {
  test('delegates to the portfolio allocation function', () => {
    expect(liveAllocationCalculator).toBe(calculatePortfolioAllocation);
    const params = {
      equity: 1_000,
      usedMargin: 0,
      entry: 100,
      stop: 90,
      direction: 'LONG' as const,
    };
    expect(calculateLiveAllocation(params)).toEqual(calculatePortfolioAllocation({
      ...params,
      leverage: config.portfolio.leverage,
      riskPerTrade: config.portfolio.riskPerTrade,
      maxPositionMargin: config.portfolio.maxPositionMargin,
      maxTotalMargin: config.portfolio.maxTotalMargin,
      feePerSide: config.backtest.feePerSide,
      slippagePerSide: config.backtest.slippagePerSide,
    }));
  });
});

describe('PAPER executor', () => {
  test('uses backtest slippage and fee assumptions for entry and exit fills', async () => {
    const executor = new PaperExecutor();
    const signal = testSignal();
    const candle = testCandle(0, 100, 106, 99, 104);
    const allocation = calculateLiveAllocation({
      equity: 1_000,
      usedMargin: 0,
      entry: signal.entry,
      stop: signal.stop,
      direction: signal.direction,
    });
    const opened = await executor.openPosition({ signal, allocation, candle });
    expect(opened.accepted).toBe(true);
    expect(opened.position?.entry).toBeCloseTo(100 * (1 + config.backtest.slippagePerSide));

    const exit: StrategyExit = {
      signal,
      exitTime: candle.closeTime,
      exitPrice: signal.target,
      reason: 'TARGET',
      durationCandles: 1,
    };
    const closed = await executor.closePosition({ position: opened.position!, exit, candle });
    const expectedExit = signal.target * (1 - config.backtest.slippagePerSide);
    expect(closed.closedTrade?.exitPrice).toBeCloseTo(expectedExit);
    expect(closed.closedTrade?.pnl).toBeGreaterThan(0);
    expect(closed.fill?.fee).toBeCloseTo(opened.position!.quantity * expectedExit * config.backtest.feePerSide);
  });
});

describe('TESTNET rounding helpers', () => {
  test('formats price significant figures and size decimals before SDK placement', () => {
    expect(formatPrice(12345.6789)).toBe('12346');
    expect(formatPrice(0.012345678)).toBe('0.012346');
    expect(formatSize(1.234567, 3)).toBe('1.234');
  });
});

function testSignal(): StrategySignal {
  return {
    type: 'CONFIRMED_SIGNAL',
    coin: 'ETH',
    side: 'SUPPORT',
    levelName: 'rangeLow',
    levelPrice: 95,
    candleCloseTime: Date.UTC(2026, 5, 8, 12),
    price: 100,
    direction: 'LONG',
    entry: 100,
    stop: 95,
    target: 105,
    score: 90,
    strategy: 'RANGE_REVERSION',
    regime: 'RANGE',
    notified: false,
  };
}

function testCandle(index: number, open: number, high: number, low: number, close: number): Candle {
  const openTime = Date.UTC(2026, 5, 8, 12) + index * 5 * 60 * 1000;
  return {
    openTime,
    closeTime: openTime + 5 * 60 * 1000,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}
