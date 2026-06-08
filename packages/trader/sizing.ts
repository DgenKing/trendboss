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
  return liveAllocationCalculator({
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
}
