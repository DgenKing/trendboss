import { type DetectionOptions, type SignalOptions } from './detect';
import {
  calculateIndicatorSeries,
  defaultRegimeOptions,
  latestIndicatorAt,
  type IndicatorSnapshot,
  type RegimeOptions,
} from './indicators';
import { computeLevels } from './levels';
import {
  RegimeAwareStrategyEngine,
  type RegimeStrategyOptions,
  type StrategyExit,
  type StrategySignal,
} from './strategy';
import type { Candle, Direction, MarketEvent, MarketRegime, StrategyName } from './types';

export type BacktestExitReason = 'TARGET' | 'STOP' | 'OPEN';

const DEFAULT_TREND_OPTIONS = {
  breakoutLookback: 40,
  atrPeriod: 14,
  atrStopMultiple: 2,
  targetR: 3,
  rsiPeriod: 14,
  rsiLongMin: 55,
  rsiShortMax: 45,
};

export interface BacktestOptions {
  coin: string;
  detection: DetectionOptions;
  signal?: SignalOptions;
  strategy?: RegimeStrategyOptions;
  regime?: RegimeOptions;
  feePerSide?: number;
  slippagePerSide?: number;
  recentCandleLimit?: number;
  recentEventLimit?: number;
  swingLookbackDays?: number;
  pivotWindow?: number;
  swingMinDistancePct?: number;
  tradeInterval?: string;
  regimeInterval?: string;
}

export interface BacktestTrade {
  direction: Direction;
  strategy: StrategyName;
  regime: MarketRegime;
  levelName: MarketEvent['levelName'];
  levelPrice: number;
  signalTime: number;
  entry: number;
  stop: number;
  target: number;
  exitTime: number;
  exitPrice: number;
  exitReason: BacktestExitReason;
  rMultiple: number;
  returnPct: number;
  durationCandles: number;
  score: number;
}

export interface BacktestSummary {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  averageR: number;
  bestR: number;
  worstR: number;
  totalReturnPct: number;
  profitFactor: number;
  maxDrawdownR: number;
}

export interface BacktestSegment {
  label: string;
  firstCandleTime: number | null;
  lastCandleTime: number | null;
  summary: BacktestSummary;
}

export interface BacktestResult {
  tradeInterval: string | null;
  regimeInterval: string | null;
  firstCandleTime: number | null;
  lastCandleTime: number | null;
  strategyCandles: number;
  levelDays: number;
  touchEvents: number;
  breakEvents: number;
  signalEvents: number;
  currentRegime: IndicatorSnapshot | null;
  exposurePct: number;
  buyHoldReturnPct: number;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  byStrategy: Record<StrategyName, BacktestSummary>;
  byRegime: Record<MarketRegime, BacktestSummary>;
  segments: {
    inSample: BacktestSegment;
    outOfSample: BacktestSegment;
  };
}

export function runBacktest(
  strategyCandles: Candle[],
  dailyCandles: Candle[],
  options: BacktestOptions,
  regimeCandles: Candle[] = [],
): BacktestResult {
  const candles = [...strategyCandles].sort((a, b) => a.openTime - b.openTime);
  const daily = [...dailyCandles].sort((a, b) => a.openTime - b.openTime);
  const hourly = [...regimeCandles].sort((a, b) => a.openTime - b.openTime);
  const indicatorSeries = calculateIndicatorSeries(hourly, options.regime ?? defaultRegimeOptions);
  const engine = new RegimeAwareStrategyEngine();
  const events: MarketEvent[] = [];
  const trades: BacktestTrade[] = [];
  const levelCache = new Map<number, ReturnType<typeof computeLevels> | null>();
  const strategy = strategyOptions(options);
  let activeSignal: StrategySignal | null = null;
  let exposedCandles = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const levels = levelsForCandle(candle, daily, options, levelCache);
    if (!levels) continue;

    if (engine.hasActiveTrade()) exposedCandles += 1;
    const recentCandles = candles.slice(
      Math.max(0, index - (options.recentCandleLimit ?? 100) + 1),
      index + 1,
    );
    const recentEvents = events.slice(-(options.recentEventLimit ?? 200));
    const update = engine.update({
      candle,
      levels,
      recentCandles,
      recentEvents,
      regime: latestIndicatorAt(indicatorSeries, candle.closeTime),
      options: strategy,
    });
    events.push(...update.events, ...update.signals);

    if (update.signals[0]) activeSignal = update.signals[0];
    if (update.exits[0] && activeSignal) {
      trades.push(tradeFromExit(activeSignal, update.exits[0], options));
      activeSignal = null;
    }
  }

  const last = candles.at(-1);
  if (activeSignal && last) {
    trades.push(openTrade(activeSignal, last, options));
  }

  const splitIndex = Math.floor(candles.length * 0.7);
  const splitTime = candles[splitIndex]?.openTime ?? Number.POSITIVE_INFINITY;
  const inSampleTrades = trades.filter((trade) => trade.signalTime < splitTime);
  const outOfSampleTrades = trades.filter((trade) => trade.signalTime >= splitTime);

  return {
    tradeInterval: options.tradeInterval ?? null,
    regimeInterval: options.regimeInterval ?? null,
    firstCandleTime: candles[0]?.openTime ?? null,
    lastCandleTime: last?.closeTime ?? null,
    strategyCandles: candles.length,
    levelDays: [...levelCache.values()].filter(Boolean).length,
    touchEvents: events.filter((event) => event.type === 'LEVEL_TOUCH').length,
    breakEvents: events.filter((event) => event.type === 'LEVEL_BREAK').length,
    signalEvents: events.filter((event) => event.type === 'CONFIRMED_SIGNAL').length,
    currentRegime: indicatorSeries.at(-1) ?? null,
    exposurePct: candles.length > 0 ? exposedCandles / candles.length : 0,
    buyHoldReturnPct: buyHoldReturn(candles),
    trades,
    summary: summarizeTrades(trades),
    byStrategy: {
      RANGE_REVERSION: summarizeTrades(trades.filter((trade) => trade.strategy === 'RANGE_REVERSION')),
      TREND_MOMENTUM: summarizeTrades(trades.filter((trade) => trade.strategy === 'TREND_MOMENTUM')),
    },
    byRegime: {
      RANGE: summarizeTrades(trades.filter((trade) => trade.regime === 'RANGE')),
      UPTREND: summarizeTrades(trades.filter((trade) => trade.regime === 'UPTREND')),
      DOWNTREND: summarizeTrades(trades.filter((trade) => trade.regime === 'DOWNTREND')),
    },
    segments: {
      inSample: segment('First 70%', candles[0]?.openTime ?? null, candles[splitIndex - 1]?.closeTime ?? null, inSampleTrades),
      outOfSample: segment('Last 30%', candles[splitIndex]?.openTime ?? null, last?.closeTime ?? null, outOfSampleTrades),
    },
  };
}

function strategyOptions(options: BacktestOptions): RegimeStrategyOptions {
  if (options.strategy) return options.strategy;
  if (!options.signal) throw new Error('Backtest options require signal or strategy settings');
  return {
    detection: options.detection,
    rangeSignal: options.signal,
    range: { enabled: true, maxAdx: Number.POSITIVE_INFINITY, targetR: Number.POSITIVE_INFINITY, minScore: 0 },
    trend: DEFAULT_TREND_OPTIONS,
  };
}

function levelsForCandle(
  candle: Candle,
  dailyCandles: Candle[],
  options: BacktestOptions,
  cache: Map<number, ReturnType<typeof computeLevels> | null>,
) {
  const todayStart = utcDayStart(candle.closeTime);
  if (cache.has(todayStart)) return cache.get(todayStart) ?? null;

  const availableDaily = dailyCandles.filter((daily) => daily.openTime < todayStart);
  try {
    const levels = computeLevels(availableDaily, {
      coin: options.coin,
      now: candle.closeTime,
      swingLookbackDays: options.swingLookbackDays ?? 0,
      pivotWindow: options.pivotWindow ?? 2,
      swingMinDistancePct: options.swingMinDistancePct ?? 0,
    });
    cache.set(todayStart, levels);
    return levels;
  } catch {
    cache.set(todayStart, null);
    return null;
  }
}

function tradeFromExit(
  signal: StrategySignal,
  exit: StrategyExit,
  options: BacktestOptions,
): BacktestTrade {
  return makeTrade(signal, exit.reason, exit.exitPrice, exit.exitTime, exit.durationCandles, options);
}

function openTrade(signal: StrategySignal, candle: Candle, options: BacktestOptions): BacktestTrade {
  return makeTrade(signal, 'OPEN', candle.close, candle.closeTime, 0, options);
}

function makeTrade(
  signal: StrategySignal,
  exitReason: BacktestExitReason,
  rawExitPrice: number,
  exitTime: number,
  durationCandles: number,
  options: BacktestOptions,
): BacktestTrade {
  const slip = options.slippagePerSide ?? 0;
  const fee = options.feePerSide ?? 0;
  const isLong = signal.direction === 'LONG';
  const entry = signal.entry * (isLong ? 1 + slip : 1 - slip);
  const exitPrice = rawExitPrice * (isLong ? 1 - slip : 1 + slip);
  const grossMove = isLong ? exitPrice - entry : entry - exitPrice;
  const netMove = grossMove - fee * (entry + exitPrice);
  const risk = Math.abs(signal.entry - signal.stop);

  return {
    direction: signal.direction,
    strategy: signal.strategy,
    regime: signal.regime,
    levelName: signal.levelName,
    levelPrice: signal.levelPrice,
    signalTime: signal.candleCloseTime,
    entry,
    stop: signal.stop,
    target: signal.target,
    exitTime,
    exitPrice,
    exitReason,
    rMultiple: risk > 0 ? netMove / risk : 0,
    returnPct: entry > 0 ? netMove / entry : 0,
    durationCandles,
    score: signal.score ?? 0,
  };
}

function summarizeTrades(trades: BacktestTrade[]): BacktestSummary {
  const closed = trades.filter((trade) => trade.exitReason !== 'OPEN');
  const rValues = trades.map((trade) => trade.rMultiple);
  const gains = sum(rValues.filter((value) => value > 0));
  const losses = Math.abs(sum(rValues.filter((value) => value <= 0)));
  const netR = sum(rValues);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of rValues) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    wins: closed.filter((trade) => trade.rMultiple > 0).length,
    losses: closed.filter((trade) => trade.rMultiple <= 0).length,
    winRate: closed.length > 0 ? closed.filter((trade) => trade.rMultiple > 0).length / closed.length : 0,
    netR,
    averageR: trades.length > 0 ? netR / trades.length : 0,
    bestR: trades.length > 0 ? Math.max(...rValues) : 0,
    worstR: trades.length > 0 ? Math.min(...rValues) : 0,
    totalReturnPct: sum(trades.map((trade) => trade.returnPct)),
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownR,
  };
}

function segment(
  label: string,
  firstCandleTime: number | null,
  lastCandleTime: number | null,
  trades: BacktestTrade[],
): BacktestSegment {
  return { label, firstCandleTime, lastCandleTime, summary: summarizeTrades(trades) };
}

function buyHoldReturn(candles: Candle[]): number {
  const first = candles[0];
  const last = candles.at(-1);
  return first && last && first.open > 0 ? (last.close - first.open) / first.open : 0;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
