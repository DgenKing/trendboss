import type { PortfolioAllocation } from '../core/portfolio';
import type { StrategyExit, StrategySignal } from '../core/strategy';
import type { Candle, Direction, MarketRegime, StrategyName } from '../core/types';
import type { TraderMode } from '../../config';

export type TraderDecisionStatus = PortfolioAllocation['status'] | 'SKIPPED';
export type TraderDecisionReason =
  | 'ALLOCATED'
  | 'PARTIAL_MARGIN'
  | 'NO_MARGIN'
  | 'ACTIVE_SYMBOL'
  | 'MAX_POSITIONS'
  | 'EXECUTOR_REJECTED'
  | 'DISABLED';

export interface LiveDecision {
  id?: number;
  coin: string;
  time: number;
  mode: TraderMode;
  direction: Direction;
  strategy: StrategyName;
  score: number;
  status: TraderDecisionStatus;
  reason: TraderDecisionReason;
  margin: number;
  notional: number;
  allocationPct: number;
  riskAtStop: number;
}

export interface LivePosition {
  coin: string;
  mode: TraderMode;
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
  quantity: number;
  currentPrice: number;
  unrealizedPnl: number;
  stopOrderId?: string | null;
  targetOrderId?: string | null;
}

export interface LiveClosedTrade extends LivePosition {
  exitTime: number;
  exitPrice: number;
  exitReason: 'TARGET' | 'STOP' | 'MANUAL' | 'TESTNET_RECONCILED';
  pnl: number;
  returnOnMargin: number;
}

export interface LiveFill {
  coin: string;
  mode: TraderMode;
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  kind: 'ENTRY' | 'EXIT' | 'TP' | 'SL';
  orderId?: string | null;
  raw?: string | null;
}

export interface EquityPoint {
  time: number;
  mode: TraderMode;
  equity: number;
  realizedBalance: number;
  usedMargin: number;
  activePositions: number;
}

export type CandleFeedSource = 'WS' | 'REST_POLL';

export interface LiveHeartbeat {
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
  feedPath: CandleFeedSource | 'NONE';
  rawChannels: Record<string, number>;
  lastRawChannel: string | null;
}

export interface LiveState {
  enabled: boolean;
  mode: TraderMode;
  tradeInterval: '5m';
  updatedAt: number | null;
  heartbeat: LiveHeartbeat | null;
  equity: number;
  realizedBalance: number;
  usedMargin: number;
  openPositions: LivePosition[];
  closedTrades: LiveClosedTrade[];
  equityPoints: EquityPoint[];
  recentDecisions: LiveDecision[];
}

export interface OpenOrderRequest {
  signal: StrategySignal;
  allocation: PortfolioAllocation;
  candle: Candle;
}

export interface OpenOrderResult {
  accepted: boolean;
  position?: LivePosition;
  fill?: LiveFill;
  reason?: string;
  raw?: unknown;
}

export interface CloseOrderRequest {
  position: LivePosition;
  exit: StrategyExit;
  candle: Candle;
}

export interface CloseOrderResult {
  accepted: boolean;
  closedTrade?: LiveClosedTrade;
  fill?: LiveFill;
  reason?: string;
  raw?: unknown;
}

export interface Executor {
  mode: TraderMode;
  openPosition(request: OpenOrderRequest): Promise<OpenOrderResult>;
  closePosition(request: CloseOrderRequest): Promise<CloseOrderResult>;
  reconcile?(): Promise<void>;
}
