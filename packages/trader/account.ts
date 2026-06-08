import { config } from '../../config';
import type { PortfolioAllocation } from '../core/portfolio';
import type { StrategyExit, StrategySignal } from '../core/strategy';
import type { Candle } from '../core/types';
import type { EquityPoint, LiveClosedTrade, LivePosition } from './types';

export class TraderAccount {
  realizedBalance: number;
  readonly positions = new Map<string, LivePosition>();

  constructor(params: {
    realizedBalance?: number;
    positions?: LivePosition[];
  } = {}) {
    this.realizedBalance = params.realizedBalance ?? config.portfolio.startingCapital;
    for (const position of params.positions ?? []) {
      this.positions.set(position.coin, position);
    }
  }

  hasPosition(coin: string): boolean {
    return this.positions.has(coin);
  }

  open(position: LivePosition) {
    this.positions.set(position.coin, position);
  }

  close(closed: LiveClosedTrade) {
    this.realizedBalance += closed.pnl;
    this.positions.delete(closed.coin);
  }

  mark(coin: string, price: number) {
    const position = this.positions.get(coin);
    if (!position) return;
    position.currentPrice = price;
    position.unrealizedPnl = markToMarket(position, price);
  }

  equity(): number {
    return this.realizedBalance + sum([...this.positions.values()].map((position) => (
      markToMarket(position, position.currentPrice)
    )));
  }

  usedMargin(): number {
    return sum([...this.positions.values()].map((position) => position.margin));
  }

  equityPoint(time: number): EquityPoint {
    return {
      time,
      mode: config.trader.mode,
      equity: this.equity(),
      realizedBalance: this.realizedBalance,
      usedMargin: this.usedMargin(),
      activePositions: this.positions.size,
    };
  }
}

export function positionFromSignal(params: {
  signal: StrategySignal;
  allocation: PortfolioAllocation;
  entryPrice: number;
  currentPrice: number;
  stopOrderId?: string | null;
  targetOrderId?: string | null;
}): LivePosition {
  const { signal, allocation, entryPrice, currentPrice, stopOrderId = null, targetOrderId = null } = params;
  const quantity = allocation.notional / entryPrice;
  const position: LivePosition = {
    coin: signal.coin,
    mode: config.trader.mode,
    direction: signal.direction,
    strategy: signal.strategy,
    regime: signal.regime,
    entryTime: signal.candleCloseTime,
    entry: entryPrice,
    stop: signal.stop,
    target: signal.target,
    score: signal.score ?? 0,
    margin: allocation.margin,
    notional: allocation.notional,
    allocationPct: allocation.allocationPct,
    riskAtStop: allocation.riskAtStop,
    quantity,
    currentPrice,
    unrealizedPnl: 0,
    stopOrderId,
    targetOrderId,
  };
  return { ...position, unrealizedPnl: markToMarket(position, currentPrice) };
}

export function closedTradeFromExit(params: {
  position: LivePosition;
  exit: StrategyExit;
  exitPrice: number;
}): LiveClosedTrade {
  const { position, exit, exitPrice } = params;
  const pnl = realizedPnl(position, exitPrice);
  return {
    ...position,
    currentPrice: exitPrice,
    unrealizedPnl: 0,
    exitTime: exit.exitTime,
    exitPrice,
    exitReason: exit.reason,
    pnl,
    returnOnMargin: position.margin > 0 ? pnl / position.margin : 0,
  };
}

export function paperEntryPrice(signal: StrategySignal): number {
  const slip = config.backtest.slippagePerSide;
  return signal.entry * (signal.direction === 'LONG' ? 1 + slip : 1 - slip);
}

export function paperExitPrice(position: LivePosition, rawExitPrice: number): number {
  const slip = config.backtest.slippagePerSide;
  return rawExitPrice * (position.direction === 'LONG' ? 1 - slip : 1 + slip);
}

export function markToMarket(position: LivePosition, currentPrice: number): number {
  const executedExit = paperExitPrice(position, currentPrice);
  return realizedPnl(position, executedExit);
}

export function realizedPnl(position: LivePosition, exitPrice: number): number {
  const gross = position.quantity * (
    position.direction === 'LONG'
      ? exitPrice - position.entry
      : position.entry - exitPrice
  );
  const fees = position.quantity * config.backtest.feePerSide * (position.entry + exitPrice);
  return gross - fees;
}

export function updatePositionMark(position: LivePosition, candle: Candle): LivePosition {
  const next = { ...position, currentPrice: candle.close };
  next.unrealizedPnl = markToMarket(next, candle.close);
  return next;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
