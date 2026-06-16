import { config } from '../../config';
import { calculatePortfolioAllocation, type PortfolioAllocation } from '../core/portfolio';
import type { Direction } from '../core/types';

export const liveAllocationCalculator = calculatePortfolioAllocation;

export function calculateLiveAllocation(params: {
  equity: number;
  usedMargin: number;
  entry: number;
  stop: number;
  direction: Direction;
}): PortfolioAllocation {
  const allocation = liveAllocationCalculator({
    equity: params.equity,
    usedMargin: params.usedMargin,
    entry: params.entry,
    stop: params.stop,
    direction: params.direction,
    leverage: config.portfolio.leverage,
    riskPerTrade: config.portfolio.riskPerTrade,
    maxPositionMargin: config.portfolio.maxPositionMargin,
    maxTotalMargin: config.portfolio.maxTotalMargin,
    feePerSide: config.backtest.feePerSide,
    slippagePerSide: config.backtest.slippagePerSide,
  });
  return capLiveAllocationMargin(allocation, config.trader.maxTradeMarginUsd, params.equity);
}

export function capLiveAllocationMargin(
  allocation: PortfolioAllocation,
  maxMarginUsd: number,
  equity: number,
): PortfolioAllocation {
  if (allocation.status === 'REJECTED' || allocation.margin <= maxMarginUsd) return allocation;
  const scale = maxMarginUsd / allocation.margin;
  return {
    ...allocation,
    margin: maxMarginUsd,
    notional: allocation.notional * scale,
    allocationPct: equity > 0 ? maxMarginUsd / equity : 0,
    riskAtStop: allocation.riskAtStop * scale,
    status: 'PARTIAL',
  };
}
