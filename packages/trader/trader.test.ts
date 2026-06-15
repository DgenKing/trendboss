import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../../config';
import { calculatePortfolioAllocation } from '../core/portfolio';
import type { StrategyExit, StrategySignal } from '../core/strategy';
import type { Candle } from '../core/types';
import { TraderAccount, updatePositionMark } from './account';
import { createHeartbeatPublisher, main } from './index';
import { entryIndicators, TraderLogger } from './logger';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation, liveAllocationCalculator } from './sizing';
import { TraderStore } from './store';
import type { LiveDecision, LivePosition } from './types';
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

describe('live heartbeat publisher', () => {
  test('times out a hung reconcile and allows the next heartbeat to publish', async () => {
    const writes: string[] = [];
    const publisher = createHeartbeatPublisher({
      reconcile: () => new Promise<void>(() => {}),
      timeoutMs: 5,
      buildHeartbeat: () => minimalHeartbeat(),
      saveHeartbeat: () => writes.push('heartbeat'),
      buildHealth: () => ({ ok: true }),
      writeHealth: () => writes.push('health'),
      logHealth: () => writes.push('log'),
      logHeartbeat: () => writes.push('print'),
      clearLastError: () => writes.push('clear'),
      recordError: (message) => writes.push(`error:${message}`),
    });

    await publisher.publish();
    await publisher.publish();

    expect(writes.filter((item) => item === 'heartbeat')).toHaveLength(2);
    expect(writes.some((item) => item.includes('timed out'))).toBe(true);
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
  test('uses clearinghouse account value without adding spot USDC twice', () => {
    expect(totalAccountEquity(
      { marginSummary: { accountValue: '20.5' } } as any,
      { balances: [{ coin: 'USDC', total: '960.25' }] },
    )).toBe(20.5);
    expect(totalAccountEquity(
      { marginSummary: { accountValue: '981' } } as any,
      { balances: [{ coin: 'USDC', total: '0' }] },
    )).toBe(981);
    expect(totalAccountEquity(
      { marginSummary: {} } as any,
      { balances: [{ coin: 'USDC', total: '960.25' }] },
    )).toBe(960.25);
    expect(totalAccountEquity({ marginSummary: {} } as any, { balances: [] })).toBe(config.portfolio.startingCapital);
  });

  test('uses spot USDC total when TESTNET isolated accountValue only reflects used margin', () => {
    expect(totalAccountEquity(
      {
        marginSummary: {
          accountValue: '249.057609',
          totalMarginUsed: '249.057609',
          totalRawUsd: '-1002.930524',
        },
      } as any,
      { balances: [{ coin: 'USDC', total: '885.247089', hold: '249.057609' }] },
    )).toBe(885.247089);
  });

  test('does not replace exchange TESTNET mark and PnL with local feed prices', () => {
    const position = testLivePosition({ currentPrice: 98.75, markPrice: 98.75, unrealizedPnl: -4.77 });
    const account = new TraderAccount({ positions: [position] });

    account.mark(position.coin, 99.5);
    expect(account.positions.get(position.coin)?.currentPrice).toBe(98.75);
    expect(account.positions.get(position.coin)?.unrealizedPnl).toBe(-4.77);

    const candleMarked = updatePositionMark(position, testCandle(0, 99, 100, 98, 99.5));
    expect(candleMarked.currentPrice).toBe(98.75);
    expect(candleMarked.unrealizedPnl).toBe(-4.77);
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

describe('TraderLogger', () => {
  test('writes cursor-friendly event JSONL records with required trade context', async () => {
    const dir = `/tmp/trendboss-logger-${Date.now()}-${Math.random()}`;
    mkdirSync(dir, { recursive: true });
    const logger = new TraderLogger('PAPER', dir);
    const signal = testSignal();
    const candle = testCandle(0, 100, 106, 99, 104);
    const executor = new PaperExecutor();
    const allocation = calculateLiveAllocation({
      equity: 1_000,
      usedMargin: 0,
      entry: signal.entry,
      stop: signal.stop,
      direction: signal.direction,
    });
    const opened = await executor.openPosition({ signal, allocation, candle });
    logger.tradeOpened({
      signal,
      position: opened.position!,
      candle,
      indicators: entryIndicators({
        candleCloseTime: candle.closeTime,
        ready: true,
        emaFast: 101,
        emaSlow: 99,
        atr: 2,
        rsi: 55,
        adx: 38,
        regime: 'RANGE',
      }, {
        candleCloseTime: candle.closeTime - 3_000_000,
        ready: true,
        emaFast: 100,
        emaSlow: 98,
        atr: 1.5,
        rsi: 50,
        adx: 30,
        regime: 'RANGE',
      }),
      equityBefore: 1_000,
      equityAfter: 1_000,
      usedMargin: opened.position!.margin,
      openPositionsCount: 1,
      entryFee: opened.fill!.fee,
      orderId: 'paper-entry-1',
    });
    logger.decision(decisionFromTestSignal(signal, 'SKIPPED', 'ACTIVE_SYMBOL'), signal);
    const exit: StrategyExit = {
      signal,
      exitTime: candle.closeTime + 5 * 60 * 1000,
      exitPrice: signal.target,
      reason: 'TARGET',
      durationCandles: 1,
    };
    const closed = await executor.closePosition({ position: opened.position!, exit, candle });
    logger.tradeClosed(closed.closedTrade!, closed.fill!.fee);
    const resumedLogger = new TraderLogger('PAPER', dir);
    resumedLogger.error('executor rejected order', {
      coin: signal.coin,
      direction: signal.direction,
      strategy: signal.strategy,
      price: signal.price,
      stop: signal.stop,
      target: signal.target,
    });

    const lines = readFileSync(`${dir}/trades-PAPER.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(4);
    for (const [index, line] of lines.entries()) {
      expect(line.eventId).toBe(index + 1);
      expect(typeof line.ts).toBe('number');
      expect(line.ts).toBeGreaterThan(0);
      expect(line.tradeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(line).toHaveProperty('symbol');
      expect(line).toHaveProperty('venue');
      expect(line.timeframe).toBe('5m');
      expect(line).toHaveProperty('status');
      expect(line).toHaveProperty('price');
      expect(line).toHaveProperty('size');
      expect(line).toHaveProperty('stop');
      expect(line).toHaveProperty('target');
      expect(line).toHaveProperty('reason');
      expect(line).toHaveProperty('skip_reason');
      expect(line).toHaveProperty('error');
      expect(line).toHaveProperty('pnl');
      expect(line).toHaveProperty('fees');
      expect(line.source).toBe('trendboss-live-trader');
      expect(line.bot_name).toBe('trendboss-live-trader');
    }
    expect(lines[0]).toMatchObject({
      event: 'OPEN',
      symbol: 'ETH',
      venue: 'PAPER',
      status: 'OPEN',
      price: opened.position!.entry,
      size: opened.position!.quantity,
      reason: 'OPEN',
      coin: 'ETH',
      mode: 'PAPER',
      exitReason: 'OPEN',
      levelName: 'rangeLow',
      levelPrice: 95,
      equityBefore: 1_000,
      openPositionsCount: 1,
      orderId: 'paper-entry-1',
    });
    expect(lines[0].indicators).toMatchObject({
      adx: 38,
      rsi: 55,
      atr: 2,
      fastEma: 101,
      slowEma: 99,
      emaSlope: 1,
      regime: 'RANGE',
      ready: true,
    });
    expect(lines[0].candle.closeTime).toBe(candle.closeTime);
    expect(lines[0].entryFee).toBeGreaterThan(0);
    expect(lines[1]).toMatchObject({
      event: 'SKIP',
      symbol: 'ETH',
      status: 'SKIPPED',
      skip_reason: 'ACTIVE_SYMBOL',
      price: signal.price,
      size: 0,
    });
    expect(lines[2]).toMatchObject({
      event: 'CLOSE',
      symbol: 'ETH',
      status: 'CLOSED',
      reason: 'TARGET',
      exitReason: 'TARGET',
    });
    expect(lines[2].tradeId).toBe(lines[0].tradeId);
    expect(lines[2].price).toBeCloseTo(closed.closedTrade!.exitPrice);
    expect(lines[2].pnl).toBeCloseTo(closed.closedTrade!.pnl);
    expect(lines[2].fees).toBeCloseTo(opened.fill!.fee + closed.fill!.fee);
    expect(lines[2].exitPrice).toBeCloseTo(closed.closedTrade!.exitPrice);
    expect(lines[2].realizedPnl).toBeCloseTo(closed.closedTrade!.pnl);
    expect(lines[2].rMultiple).toBeGreaterThan(0);
    expect(lines[2].exitFee).toBeCloseTo(closed.fill!.fee);
    expect(lines[2].totalFees).toBeCloseTo(opened.fill!.fee + closed.fill!.fee);
    expect(lines[3]).toMatchObject({
      event: 'ERROR',
      eventId: 4,
      symbol: 'ETH',
      status: 'ERROR',
      error: 'executor rejected order',
    });
    expect(JSON.parse(readFileSync(`${dir}/trades-PAPER.manifest.json`, 'utf8')).activeTradeLog).toBe(`${dir}/trades-PAPER.jsonl`);
  });

  test('writes date-rolled text logs and never throws on write failure', () => {
    const dir = `/tmp/trendboss-logger-text-${Date.now()}-${Math.random()}`;
    const logger = new TraderLogger('TESTNET', dir);
    logger.text('[decision] ETH SKIPPED NO_MARGIN');
    const date = new Date().toISOString().slice(0, 10);
    expect(readFileSync(`${dir}/TESTNET-${date}.log`, 'utf8')).toContain('NO_MARGIN');

    const blockedPath = `/tmp/trendboss-logger-blocked-${Date.now()}-${Math.random()}`;
    writeFileSync(blockedPath, 'not a directory');
    const failingLogger = new TraderLogger('PAPER', blockedPath);
    expect(() => failingLogger.text('this write fails but does not throw')).not.toThrow();
    expect(existsSync(blockedPath)).toBe(true);
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

function minimalHeartbeat() {
  return {
    time: Date.now(),
    startedAt: Date.now() - 1_000,
    uptimeSeconds: 1,
    socketHealthy: true,
    secondsSinceLastMessage: 1,
    closedCandlesByInterval: {},
    lastClosedCandleByCoin: {},
    signalsSeen: 0,
    openPositions: 0,
    lastAction: 'none',
    lastError: null,
    feedPath: 'WS' as const,
    rawChannels: {},
    lastRawChannel: null,
    currentPriceByCoin: {},
    lastSignalByCoin: {},
    lastOrderAttemptByCoin: {},
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

function decisionFromTestSignal(
  signal: StrategySignal,
  status: LiveDecision['status'],
  reason: LiveDecision['reason'],
): LiveDecision {
  return {
    coin: signal.coin,
    time: signal.candleCloseTime,
    mode: 'PAPER',
    direction: signal.direction,
    strategy: signal.strategy,
    score: signal.score ?? 0,
    status,
    reason,
    margin: 0,
    notional: 0,
    allocationPct: 0,
    riskAtStop: 0,
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
