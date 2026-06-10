import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { calculatePortfolioAllocation } from '../core/portfolio';
import type { StrategyExit, StrategySignal } from '../core/strategy';
import type { Candle } from '../core/types';
import { main } from './index';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation, liveAllocationCalculator } from './sizing';
import { TraderStore } from './store';
import type { LivePosition } from './types';
import {
  acceptedOrderId,
  closedTradeFromExchangeFlat,
  formatPrice,
  formatSize,
  inferExitReason,
  loadTestnetSecret,
  orderStatusError,
  plainCoin,
  totalAccountEquity,
} from './testnet';

describe('trader config safety', () => {
  test('enabled:false is a no-op', async () => {
    expect(config.trader.enabled).toBe(false);
    await expect(main()).resolves.toBeUndefined();
  });

  test('TESTNET refuses to start without the gitignored secret', async () => {
    const missingSecret = new URL('../../trader.secret.missing.ts', import.meta.url).pathname;
    await expect(loadTestnetSecret(missingSecret)).rejects.toThrow('trader.secret.ts');
  });

  test('TESTNET trader coin selection excludes dead ZEC market', () => {
    expect(config.trader.coins).not.toContain('ZEC');
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

  test('normalizes SDK perp metadata names to plain configured coins', () => {
    expect(plainCoin('NEAR-PERP')).toBe('NEAR');
    expect(plainCoin('NEAR')).toBe('NEAR');
  });

  test('recognizes trigger order ids from known and nested success shapes', () => {
    expect(acceptedOrderId(orderResponse({ resting: { oid: 123 } }))).toBe('123');
    expect(acceptedOrderId(orderResponse({ trigger: { oid: 456 } }))).toBe('456');
    expect(acceptedOrderId(orderResponse({ accepted: { oid: '789' } }))).toBe('789');
  });

  test('detects per-order errors inside exchange statuses', () => {
    expect(orderStatusError(orderResponse({ error: 'Order would immediately trigger.' }))).toBe('Order would immediately trigger.');
    expect(orderStatusError(orderResponse('Reduce only order would increase position.'))).toBe('Reduce only order would increase position.');
    expect(orderStatusError(orderResponse('waitingForTrigger'))).toBeNull();
    expect(acceptedOrderId(orderResponse({ error: 'No position to reduce.' }))).toBeNull();
  });
});

describe('TESTNET reconciliation helpers', () => {
  test('sums spot USDC and perps account value for total equity', () => {
    expect(totalAccountEquity(
      { marginSummary: { accountValue: '20.5' } } as any,
      { balances: [{ coin: 'USDC', total: '960.25' }] },
    )).toBeCloseTo(980.75);
    expect(totalAccountEquity(
      { marginSummary: { accountValue: '981' } } as any,
      { balances: [{ coin: 'USDC', total: '0' }] },
    )).toBe(981);
    expect(totalAccountEquity({ marginSummary: {} } as any, { balances: [] })).toBe(config.portfolio.startingCapital);
  });

  test('uses latest closing fill time, not reconcile time, for exchange-flat trades', () => {
    const position = testLivePosition({ stopOrderId: '111', targetOrderId: '222' });
    const trade = closedTradeFromExchangeFlat(position, [
      userFill({ time: position.entryTime, oid: 10, closedPnl: '0', fee: '0.02' }),
      userFill({ time: position.entryTime + 1_000, oid: 111, closedPnl: '-3', fee: '0.03', px: '95', sz: '0.5' }),
      userFill({ time: position.entryTime + 2_000, oid: 111, closedPnl: '-2', fee: '0.04', px: '94', sz: '0.5' }),
    ]);
    expect(trade.exitTime).toBe(position.entryTime + 2_000);
    expect(trade.exitReason).toBe('STOP');
    expect(trade.exitPrice).toBeCloseTo(94.5);
    expect(trade.pnl).toBeCloseTo(-5.07);
  });

  test('prefers filled trigger oid and avoids impossible price-only target labels', () => {
    const position = testLivePosition({ stopOrderId: '111', targetOrderId: '222' });
    expect(inferExitReason(position, 104, [{ oid: 222, time: 2 }])).toBe('TARGET');
    expect(inferExitReason(position, 96, [{ oid: 111, time: 2 }])).toBe('STOP');
    expect(inferExitReason({ ...position, target: 96 }, 96)).toBe('TESTNET_RECONCILED');
  });
});

describe('TraderStore live state persistence', () => {
  test('updates an equity point instead of inserting duplicates for the same mode and time', () => {
    const store = new TraderStore(`/tmp/trendboss-trader-${Date.now()}-${Math.random()}.db`);
    const time = Date.UTC(2026, 5, 10, 12);
    store.saveEquityPoint({
      time,
      mode: 'TESTNET',
      equity: 900,
      realizedBalance: 900,
      usedMargin: 10,
      activePositions: 1,
    });
    store.saveEquityPoint({
      time,
      mode: 'TESTNET',
      equity: 925,
      realizedBalance: 920,
      usedMargin: 20,
      activePositions: 2,
    });
    const state = store.getLiveState();
    store.close();
    expect(state.equityPoints).toHaveLength(1);
    expect(state.equityPoints[0].equity).toBe(925);
    expect(state.equityPoints[0].activePositions).toBe(2);
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

function orderResponse(status: unknown) {
  return {
    status: 'ok',
    response: {
      type: 'order',
      data: {
        statuses: [status],
      },
    },
  };
}

function testLivePosition(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    coin: 'ETH',
    mode: 'TESTNET',
    direction: 'LONG',
    strategy: 'RANGE_REVERSION',
    regime: 'RANGE',
    entryTime: Date.UTC(2026, 5, 10, 12),
    entry: 100,
    stop: 95,
    target: 105,
    score: 90,
    margin: 100,
    notional: 500,
    allocationPct: 0.1,
    riskAtStop: 20,
    quantity: 1,
    currentPrice: 100,
    unrealizedPnl: 0,
    markPrice: 100,
    liquidationPrice: null,
    fees: 0,
    stopOrderId: null,
    targetOrderId: null,
    ...overrides,
  };
}

function userFill(overrides: Partial<{
  closedPnl: string;
  coin: string;
  dir: string;
  fee: string;
  oid: number;
  px: string;
  side: string;
  startPosition: string;
  sz: string;
  time: number;
}> = {}) {
  return {
    closedPnl: '0',
    coin: 'ETH',
    dir: 'Close Long',
    fee: '0',
    oid: 1,
    px: '100',
    side: 'A',
    startPosition: '1',
    sz: '1',
    time: Date.UTC(2026, 5, 10, 12),
    ...overrides,
  };
}
