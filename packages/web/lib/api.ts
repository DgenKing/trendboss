export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Levels = {
  coin: string;
  computedAt: number;
  forUtcDay: string;
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
};

export type MarketEvent = {
  id?: number;
  type: 'LEVEL_TOUCH' | 'LEVEL_BREAK' | 'CONFIRMED_SIGNAL';
  coin: string;
  side: 'RESISTANCE' | 'SUPPORT';
  levelName: 'rangeHigh' | 'rangeLow' | 'swingHigh' | 'swingLow' | 'trendBreakoutHigh' | 'trendBreakoutLow';
  levelPrice: number;
  candleCloseTime: number;
  price: number;
  direction?: 'LONG' | 'SHORT';
  entry?: number;
  stop?: number;
  target?: number;
  score?: number;
  strategy?: 'RANGE_REVERSION' | 'TREND_MOMENTUM';
  regime?: 'UPTREND' | 'DOWNTREND' | 'RANGE';
  notified: boolean;
};

export type Status = {
  coin: string;
  coins: string[];
  lastCandleTime: number | null;
  socketHealthy: boolean;
  currentPrice: number | null;
};

export type LiveState = {
  enabled: boolean;
  mode: 'PAPER' | 'TESTNET';
  tradeInterval: '5m';
  updatedAt: number | null;
  heartbeat: LiveHeartbeat | null;
  equity: number;
  realizedBalance: number;
  usedMargin: number;
  openPositions: LivePosition[];
  closedTrades: LiveClosedTrade[];
  equityPoints: Array<{
    time: number;
    mode: 'PAPER' | 'TESTNET';
    equity: number;
    realizedBalance: number;
    usedMargin: number;
    activePositions: number;
  }>;
  recentDecisions: Array<{
    id?: number;
    coin: string;
    time: number;
    mode: 'PAPER' | 'TESTNET';
    direction: 'LONG' | 'SHORT';
    strategy: string;
    score: number;
    status: string;
    reason: string;
    margin: number;
    notional: number;
    allocationPct: number;
    riskAtStop: number;
  }>;
};

export type LiveHeartbeat = {
  time: number;
  startedAt: number;
  uptimeSeconds: number;
  socketHealthy: boolean;
  secondsSinceLastMessage: number | null;
  closedCandlesByInterval: Record<string, number>;
  lastClosedCandleByCoin: Record<string, number | null>;
  signalsSeen: number;
  openPositions: number;
  lastAction: string;
  lastError: string | null;
  feedPath: 'WS' | 'REST_POLL' | 'NONE';
  rawChannels: Record<string, number>;
  lastRawChannel: string | null;
};

export type LivePosition = {
  coin: string;
  mode: 'PAPER' | 'TESTNET';
  direction: 'LONG' | 'SHORT';
  strategy: string;
  regime: string;
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  score: number;
  margin: number;
  notional: number;
  allocationPct: number;
  riskAtStop: number;
  quantity: number;
  currentPrice: number;
  unrealizedPnl: number;
  markPrice?: number | null;
  liquidationPrice?: number | null;
  fees?: number;
};

export type LiveClosedTrade = LivePosition & {
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  returnOnMargin: number;
};

const API_BASE = process.env.NEXT_PUBLIC_MONITOR_API ?? 'http://localhost:8787';
export const CHART_CANDLE_LIMIT = 5000;

export async function getCoins(): Promise<string[]> {
  return fetchJson<string[]>('/api/coins');
}

export async function getIntervals(): Promise<string[]> {
  return fetchJson<string[]>('/api/intervals');
}

export async function getTradeIntervals(): Promise<string[]> {
  return fetchJson<string[]>('/api/trade-intervals');
}

export async function getPortfolio(interval: string): Promise<PortfolioResult> {
  return fetchJson<PortfolioResult>(`/api/portfolio?interval=${encodeURIComponent(interval)}`);
}

export async function getBacktest(coin: string, interval: string): Promise<BacktestResult> {
  const q = `coin=${encodeURIComponent(coin)}&interval=${encodeURIComponent(interval)}`;
  return fetchJson<BacktestResult>(`/api/backtest?${q}`);
}

export async function getLiveState(): Promise<LiveState> {
  return fetchJson<LiveState>('/api/live');
}

export async function getDashboardData(coin: string, interval: string) {
  const q = `coin=${encodeURIComponent(coin)}`;
  const candlesQ = `${q}&interval=${encodeURIComponent(interval)}&limit=${CHART_CANDLE_LIMIT}`;
  const [levels, candles, events, status] = await Promise.all([
    fetchJson<Levels | null>(`/api/levels?${q}`),
    fetchJson<Candle[]>(`/api/candles?${candlesQ}`),
    fetchJson<MarketEvent[]>(`/api/events?${q}&limit=50`),
    fetchJson<Status>(`/api/status?${q}`),
  ]);

  return { levels, candles, events, status };
}

export async function getCandles(
  coin: string,
  interval: string,
  limit = CHART_CANDLE_LIMIT,
): Promise<Candle[]> {
  const q = `coin=${encodeURIComponent(coin)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  return fetchJson<Candle[]>(`/api/candles?${q}`);
}

// "xyz:SP500" -> "SP500" for display.
export function displayCoin(coin: string): string {
  return coin.includes(':') ? coin.split(':').slice(1).join(':') : coin;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}
import type { PortfolioResult } from '../../core/portfolio';
import type { BacktestResult } from '../../core/backtest';
