import { runBacktest, type BacktestOptions, type BacktestTrade } from './backtest';
import {
  calculateIndicatorSeries,
  defaultRegimeOptions,
  type RegimeOptions,
} from './indicators';
import type { Candle, Direction, MarketRegime, StrategyName } from './types';

export interface PortfolioSymbolData {
  coin: string;
  strategyCandles: Candle[];
  regimeCandles: Candle[];
  dailyCandles: Candle[];
}

export interface PortfolioSimulationOptions {
  startingCapital: number;
  leverage: number;
  riskPerTrade: number;
  maxPositionMargin: number;
  maxTotalMargin: number;
  feePerSide: number;
  slippagePerSide: number;
  tradeInterval?: string;
  regimeInterval?: string;
}

export interface PortfolioBacktestOptions extends PortfolioSimulationOptions {
  backtest: Omit<BacktestOptions, 'coin'>;
  regime?: RegimeOptions;
  tradeInterval?: string;
  regimeInterval?: string;
}

export interface PortfolioCandidateTrade extends BacktestTrade {
  coin: string;
}

export interface PortfolioAllocation {
  margin: number;
  notional: number;
  allocationPct: number;
  riskAtStop: number;
  desiredMargin: number;
  status: 'ACCEPTED' | 'PARTIAL' | 'REJECTED';
}

export interface PortfolioDecision {
  coin: string;
  time: number;
  direction: Direction;
  strategy: StrategyName;
  score: number;
  status: PortfolioAllocation['status'];
  margin: number;
  notional: number;
  allocationPct: number;
  riskAtStop: number;
  reason: 'ALLOCATED' | 'PARTIAL_MARGIN' | 'NO_MARGIN' | 'ACTIVE_SYMBOL';
}

export interface PortfolioPosition {
  coin: string;
  direction: Direction;
  strategy: StrategyName;
  regime: MarketRegime;
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  score: number;
  margin: number;
  notional: number;
  allocationPct: number;
  riskAtStop: number;
  currentPrice: number;
  unrealizedPnl: number;
}

export interface PortfolioClosedTrade extends PortfolioPosition {
  exitTime: number;
  exitPrice: number;
  exitReason: BacktestTrade['exitReason'] | 'LIQUIDATION';
  pnl: number;
  returnOnMargin: number;
}

export interface PortfolioPoint {
  time: number;
  equity: number;
  realizedBalance: number;
  usedMargin: number;
  usedMarginPct: number;
  grossNotional: number;
  grossExposurePct: number;
  drawdownPct: number;
  activePositions: number;
}

export interface PortfolioAttribution {
  label: string;
  trades: number;
  pnl: number;
}

export interface PortfolioResult {
  tradeInterval: string | null;
  regimeInterval: string | null;
  commonStartTime: number | null;
  commonEndTime: number | null;
  summary: {
    startingCapital: number;
    finalEquity: number;
    totalReturnPct: number;
    peakEquity: number;
    maxDrawdownPct: number;
    closedTrades: number;
    activePositions: number;
    acceptedSignals: number;
    partialSignals: number;
    rejectedSignals: number;
    liquidations: number;
    profitFactor: number;
    feesPaid: number;
  };
  timeline: PortfolioPoint[];
  activePositions: PortfolioPosition[];
  closedTrades: PortfolioClosedTrade[];
  decisions: PortfolioDecision[];
  bySymbol: PortfolioAttribution[];
  byStrategy: PortfolioAttribution[];
}

type OpenPosition = PortfolioPosition & {
  candidate: PortfolioCandidateTrade;
};

export function runPortfolioBacktest(
  symbols: PortfolioSymbolData[],
  options: PortfolioBacktestOptions,
): PortfolioResult {
  const commonStartTime = portfolioCommonStart(symbols, options.regime);
  const commonEndTime = portfolioCommonEnd(symbols);
  if (commonStartTime === null || commonEndTime === null || commonStartTime > commonEndTime) {
    return emptyResult(options.startingCapital, options.tradeInterval ?? null, options.regimeInterval ?? null);
  }

  const candidates = symbols.flatMap((symbol) => {
    const strategyCandles = symbol.strategyCandles.filter((candle) => (
      candle.closeTime >= commonStartTime && candle.closeTime <= commonEndTime
    ));
    const result = runBacktest(
      strategyCandles,
      symbol.dailyCandles,
      {
        ...options.backtest,
        coin: symbol.coin,
        tradeInterval: options.tradeInterval,
        regimeInterval: options.regimeInterval,
      },
      symbol.regimeCandles,
    );
    return result.trades.map((trade) => ({ ...trade, coin: symbol.coin }));
  });
  const candlesByCoin = Object.fromEntries(symbols.map((symbol) => [
    symbol.coin,
    symbol.strategyCandles.filter((candle) => (
      candle.closeTime >= commonStartTime && candle.closeTime <= commonEndTime
    )),
  ]));

  return simulatePortfolioTrades(
    candidates,
    candlesByCoin,
    options,
    commonStartTime,
    commonEndTime,
  );
}

export function calculatePortfolioAllocation(params: {
  equity: number;
  usedMargin: number;
  entry: number;
  stop: number;
  direction: Direction;
  leverage: number;
  riskPerTrade: number;
  maxPositionMargin: number;
  maxTotalMargin: number;
  feePerSide: number;
  slippagePerSide: number;
}): PortfolioAllocation {
  const {
    equity,
    usedMargin,
    entry,
    stop,
    direction,
    leverage,
    riskPerTrade,
    maxPositionMargin,
    maxTotalMargin,
    feePerSide,
    slippagePerSide,
  } = params;
  if (equity <= 0 || entry <= 0 || leverage <= 0) return rejectedAllocation();

  const isLong = direction === 'LONG';
  const executedEntry = entry * (isLong ? 1 + slippagePerSide : 1 - slippagePerSide);
  const executedStop = stop * (isLong ? 1 - slippagePerSide : 1 + slippagePerSide);
  const adverseMove = Math.max(0, isLong ? executedEntry - executedStop : executedStop - executedEntry);
  const lossPerUnit = adverseMove + feePerSide * (executedEntry + executedStop);
  if (lossPerUnit <= 0) return rejectedAllocation();

  const riskBudget = equity * riskPerTrade;
  const desiredNotional = riskBudget / (lossPerUnit / executedEntry);
  const desiredMargin = desiredNotional / leverage;
  const positionCap = equity * maxPositionMargin;
  const totalCap = equity * maxTotalMargin;
  const availableMargin = Math.max(0, totalCap - usedMargin);
  const margin = Math.max(0, Math.min(desiredMargin, positionCap, availableMargin));
  if (margin <= 0) return rejectedAllocation(desiredMargin);

  const notional = margin * leverage;
  const riskAtStop = notional * lossPerUnit / executedEntry;
  const constrained = margin + 1e-9 < Math.min(desiredMargin, positionCap);
  return {
    margin,
    notional,
    allocationPct: margin / equity,
    riskAtStop,
    desiredMargin,
    status: constrained ? 'PARTIAL' : 'ACCEPTED',
  };
}

export function simulatePortfolioTrades(
  candidates: PortfolioCandidateTrade[],
  candlesByCoin: Record<string, Candle[]>,
  options: PortfolioSimulationOptions,
  commonStartTime: number,
  commonEndTime: number,
): PortfolioResult {
  const sortedCandidates = [...candidates]
    .filter((trade) => trade.signalTime >= commonStartTime && trade.signalTime <= commonEndTime)
    .sort(compareCandidates);
  const candidatesByTime = groupBy(sortedCandidates, (trade) => trade.signalTime);
  const candlesAtTime = new Map<number, Array<{ coin: string; candle: Candle }>>();
  const times = new Set<number>([commonStartTime, commonEndTime]);
  for (const [coin, candles] of Object.entries(candlesByCoin)) {
    for (const candle of candles) {
      if (candle.closeTime < commonStartTime || candle.closeTime > commonEndTime) continue;
      times.add(candle.closeTime);
      const rows = candlesAtTime.get(candle.closeTime) ?? [];
      rows.push({ coin, candle });
      candlesAtTime.set(candle.closeTime, rows);
    }
  }
  for (const trade of sortedCandidates) {
    times.add(trade.signalTime);
    times.add(Math.min(commonEndTime, trade.exitTime));
  }

  let realizedBalance = options.startingCapital;
  let peakEquity = options.startingCapital;
  let maxDrawdownPct = 0;
  const open = new Map<string, OpenPosition>();
  const lastPrices = new Map<string, number>();
  const timeline: PortfolioPoint[] = [];
  const closedTrades: PortfolioClosedTrade[] = [];
  const decisions: PortfolioDecision[] = [];

  for (const time of [...times].sort((a, b) => a - b)) {
    const currentCandles = candlesAtTime.get(time) ?? [];
    for (const { coin, candle } of currentCandles) lastPrices.set(coin, candle.close);

    for (const position of [...open.values()]) {
      const current = currentCandles.find((row) => row.coin === position.coin)?.candle;
      if (current && hitsLiquidation(position, current, options.leverage)) {
        const closed = closePosition(position, time, liquidationPrice(position.entry, position.direction, options.leverage), 'LIQUIDATION', options);
        realizedBalance += closed.pnl;
        closedTrades.push(closed);
        open.delete(position.coin);
        continue;
      }
      if (position.candidate.exitTime <= time && position.candidate.exitReason !== 'OPEN') {
        const closed = closeCandidatePosition(position, options);
        realizedBalance += closed.pnl;
        closedTrades.push(closed);
        open.delete(position.coin);
      }
    }

    let equity = portfolioEquity(realizedBalance, open, lastPrices, options);
    let usedMargin = sum([...open.values()].map((position) => position.margin));
    const entries = [...(candidatesByTime.get(time) ?? [])].sort(compareCandidates);
    const sameCandleCloses: OpenPosition[] = [];

    for (const candidate of entries) {
      if (open.has(candidate.coin)) {
        decisions.push(decision(candidate, rejectedAllocation(), 'ACTIVE_SYMBOL'));
        continue;
      }
      const allocation = calculatePortfolioAllocation({
        equity,
        usedMargin,
        entry: candidate.entry,
        stop: candidate.stop,
        direction: candidate.direction,
        ...options,
      });
      if (allocation.status === 'REJECTED') {
        decisions.push(decision(candidate, allocation, 'NO_MARGIN'));
        continue;
      }

      const position: OpenPosition = {
        coin: candidate.coin,
        direction: candidate.direction,
        strategy: candidate.strategy,
        regime: candidate.regime,
        entryTime: candidate.signalTime,
        entry: candidate.entry,
        stop: candidate.stop,
        target: candidate.target,
        score: candidate.score,
        margin: allocation.margin,
        notional: allocation.notional,
        allocationPct: allocation.allocationPct,
        riskAtStop: allocation.riskAtStop,
        currentPrice: lastPrices.get(candidate.coin) ?? candidate.entry,
        unrealizedPnl: 0,
        candidate,
      };
      open.set(candidate.coin, position);
      usedMargin += allocation.margin;
      decisions.push(decision(
        candidate,
        allocation,
        allocation.status === 'PARTIAL' ? 'PARTIAL_MARGIN' : 'ALLOCATED',
      ));
      if (candidate.exitTime <= time && candidate.exitReason !== 'OPEN') sameCandleCloses.push(position);
    }

    for (const position of sameCandleCloses) {
      const closed = closeCandidatePosition(position, options);
      realizedBalance += closed.pnl;
      closedTrades.push(closed);
      open.delete(position.coin);
    }

    equity = portfolioEquity(realizedBalance, open, lastPrices, options);
    usedMargin = sum([...open.values()].map((position) => position.margin));
    const grossNotional = sum([...open.values()].map((position) => position.notional));
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    timeline.push({
      time,
      equity,
      realizedBalance,
      usedMargin,
      usedMarginPct: equity > 0 ? usedMargin / equity : 0,
      grossNotional,
      grossExposurePct: equity > 0 ? grossNotional / equity : 0,
      drawdownPct,
      activePositions: open.size,
    });
  }

  const activePositions = [...open.values()].map((position) => publicPosition(
    position,
    lastPrices.get(position.coin) ?? position.entry,
    options,
  ));
  const finalEquity = timeline.at(-1)?.equity ?? options.startingCapital;
  const gains = sum(closedTrades.filter((trade) => trade.pnl > 0).map((trade) => trade.pnl));
  const losses = Math.abs(sum(closedTrades.filter((trade) => trade.pnl <= 0).map((trade) => trade.pnl)));

  return {
    tradeInterval: options.tradeInterval ?? null,
    regimeInterval: options.regimeInterval ?? null,
    commonStartTime,
    commonEndTime,
    summary: {
      startingCapital: options.startingCapital,
      finalEquity,
      totalReturnPct: options.startingCapital > 0 ? (finalEquity - options.startingCapital) / options.startingCapital : 0,
      peakEquity,
      maxDrawdownPct,
      closedTrades: closedTrades.length,
      activePositions: activePositions.length,
      acceptedSignals: decisions.filter((item) => item.status === 'ACCEPTED').length,
      partialSignals: decisions.filter((item) => item.status === 'PARTIAL').length,
      rejectedSignals: decisions.filter((item) => item.status === 'REJECTED').length,
      liquidations: closedTrades.filter((trade) => trade.exitReason === 'LIQUIDATION').length,
      profitFactor: losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : 0,
      feesPaid: sum(closedTrades.map((trade) => trade.notional * options.feePerSide * 2)),
    },
    timeline,
    activePositions,
    closedTrades,
    decisions,
    bySymbol: attribution(closedTrades, (trade) => trade.coin),
    byStrategy: attribution(closedTrades, (trade) => trade.strategy),
  };
}

export function portfolioCommonStart(
  symbols: PortfolioSymbolData[],
  regimeOptions: RegimeOptions = defaultRegimeOptions,
): number | null {
  if (symbols.length === 0) return null;
  const starts = symbols.map((symbol) => {
    const firstStrategy = [...symbol.strategyCandles].sort((a, b) => a.closeTime - b.closeTime)[0]?.closeTime;
    const firstDaily = [...symbol.dailyCandles].sort((a, b) => a.closeTime - b.closeTime)[0]?.closeTime;
    const firstReadyRegime = calculateIndicatorSeries(symbol.regimeCandles, regimeOptions)
      .find((item) => item.ready)?.candleCloseTime;
    if (!firstStrategy || !firstDaily || !firstReadyRegime) return null;
    return Math.max(firstStrategy, firstDaily, firstReadyRegime);
  });
  return starts.some((start) => start === null) ? null : Math.max(...starts as number[]);
}

function portfolioCommonEnd(symbols: PortfolioSymbolData[]): number | null {
  if (symbols.length === 0) return null;
  const ends = symbols.map((symbol) => [...symbol.strategyCandles]
    .sort((a, b) => a.closeTime - b.closeTime).at(-1)?.closeTime ?? null);
  return ends.some((end) => end === null) ? null : Math.min(...ends as number[]);
}

function hitsLiquidation(position: OpenPosition, candle: Candle, leverage: number): boolean {
  const price = liquidationPrice(position.entry, position.direction, leverage);
  return position.direction === 'LONG' ? candle.low <= price : candle.high >= price;
}

function liquidationPrice(entry: number, direction: Direction, leverage: number): number {
  return direction === 'LONG' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
}

function closeCandidatePosition(
  position: OpenPosition,
  options: PortfolioSimulationOptions,
): PortfolioClosedTrade {
  return {
    ...publicPosition(position, position.candidate.exitPrice, options),
    exitTime: position.candidate.exitTime,
    exitPrice: position.candidate.exitPrice,
    exitReason: position.candidate.exitReason,
    pnl: position.notional * position.candidate.returnPct,
    returnOnMargin: position.margin > 0 ? position.notional * position.candidate.returnPct / position.margin : 0,
  };
}

function closePosition(
  position: OpenPosition,
  exitTime: number,
  exitPrice: number,
  exitReason: PortfolioClosedTrade['exitReason'],
  options: PortfolioSimulationOptions,
): PortfolioClosedTrade {
  const pnl = Math.max(-position.margin, markToMarket(position, exitPrice, options));
  return {
    ...publicPosition(position, exitPrice, options),
    exitTime,
    exitPrice,
    exitReason,
    pnl,
    returnOnMargin: position.margin > 0 ? pnl / position.margin : 0,
  };
}

function publicPosition(
  position: OpenPosition,
  currentPrice: number,
  options: PortfolioSimulationOptions,
): PortfolioPosition {
  return {
    coin: position.coin,
    direction: position.direction,
    strategy: position.strategy,
    regime: position.regime,
    entryTime: position.entryTime,
    entry: position.entry,
    stop: position.stop,
    target: position.target,
    score: position.score,
    margin: position.margin,
    notional: position.notional,
    allocationPct: position.allocationPct,
    riskAtStop: position.riskAtStop,
    currentPrice,
    unrealizedPnl: markToMarket(position, currentPrice, options),
  };
}

function markToMarket(
  position: OpenPosition,
  currentPrice: number,
  options: PortfolioSimulationOptions,
): number {
  const isLong = position.direction === 'LONG';
  const executedExit = currentPrice * (isLong ? 1 - options.slippagePerSide : 1 + options.slippagePerSide);
  const quantity = position.notional / position.entry;
  const gross = quantity * (isLong ? executedExit - position.entry : position.entry - executedExit);
  return gross - quantity * options.feePerSide * (position.entry + executedExit);
}

function portfolioEquity(
  realizedBalance: number,
  open: Map<string, OpenPosition>,
  lastPrices: Map<string, number>,
  options: PortfolioSimulationOptions,
): number {
  return realizedBalance + sum([...open.values()].map((position) => markToMarket(
    position,
    lastPrices.get(position.coin) ?? position.entry,
    options,
  )));
}

function decision(
  candidate: PortfolioCandidateTrade,
  allocation: PortfolioAllocation,
  reason: PortfolioDecision['reason'],
): PortfolioDecision {
  return {
    coin: candidate.coin,
    time: candidate.signalTime,
    direction: candidate.direction,
    strategy: candidate.strategy,
    score: candidate.score,
    status: allocation.status,
    margin: allocation.margin,
    notional: allocation.notional,
    allocationPct: allocation.allocationPct,
    riskAtStop: allocation.riskAtStop,
    reason,
  };
}

function rejectedAllocation(desiredMargin = 0): PortfolioAllocation {
  return {
    margin: 0,
    notional: 0,
    allocationPct: 0,
    riskAtStop: 0,
    desiredMargin,
    status: 'REJECTED',
  };
}

function attribution(
  trades: PortfolioClosedTrade[],
  label: (trade: PortfolioClosedTrade) => string,
): PortfolioAttribution[] {
  const groups = new Map<string, PortfolioAttribution>();
  for (const trade of trades) {
    const key = label(trade);
    const group = groups.get(key) ?? { label: key, trades: 0, pnl: 0 };
    group.trades += 1;
    group.pnl += trade.pnl;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.pnl - a.pnl);
}

function compareCandidates(a: PortfolioCandidateTrade, b: PortfolioCandidateTrade): number {
  return a.signalTime - b.signalTime || b.score - a.score || a.coin.localeCompare(b.coin);
}

function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), value]);
  }
  return groups;
}

function emptyResult(
  startingCapital: number,
  tradeInterval: string | null = null,
  regimeInterval: string | null = null,
): PortfolioResult {
  return {
    tradeInterval,
    regimeInterval,
    commonStartTime: null,
    commonEndTime: null,
    summary: {
      startingCapital,
      finalEquity: startingCapital,
      totalReturnPct: 0,
      peakEquity: startingCapital,
      maxDrawdownPct: 0,
      closedTrades: 0,
      activePositions: 0,
      acceptedSignals: 0,
      partialSignals: 0,
      rejectedSignals: 0,
      liquidations: 0,
      profitFactor: 0,
      feesPaid: 0,
    },
    timeline: [],
    activePositions: [],
    closedTrades: [],
    decisions: [],
    bySymbol: [],
    byStrategy: [],
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
