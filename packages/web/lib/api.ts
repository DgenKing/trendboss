export type LivePosition = {
  coin: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryTime: number;
  entry: number;
  stop: number;
  target: number;
  margin: number;
  notional: number;
  quantity: number;
  currentPrice: number;
  unrealizedPnl: number;
  fees?: number;
  botName?: string | null;
};

export type SignalSummary = {
  time: number;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  score: number;
  entry: number;
  stop: number;
  target: number;
};

export type OrderAttemptSummary = {
  time: number;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  status: string;
  reason: string;
  margin: number;
  notional: number;
};

export type HealthCoin = {
  coin: string;
  price: number | null;
  lastClosed5mCandle: number | null;
  position: LivePosition | null;
  lastSignal: SignalSummary | null;
  lastOrderAttempt: OrderAttemptSummary | null;
};

export type HealthPayload = {
  ok: boolean;
  mode: 'TESTNET' | 'PAPER';
  coins: HealthCoin[];
  traderRunning: boolean;
  traderProcessCount: number;
  feedSocketStatus: 'HEALTHY' | 'REST_FALLBACK' | 'STALE';
  heartbeatAgeSec: number | null;
  equity: number;
  usedMargin: number;
  lastError: string | null;
  secretPresent: boolean;
  updatedAt: number;
};

export type EventType = 'HEARTBEAT' | 'SIGNAL' | 'ORDER_ATTEMPT' | 'OPEN' | 'CLOSE' | 'ERROR' | 'SKIP';

export type EventRecord = {
  eventId: number;
  ts: number;
  type: EventType;
  event: EventType;
  tradeId: string;
  symbol: string | null;
  direction: string | null;
  strategy: string | null;
  status: string;
  price: number | null;
  size: number | null;
  stop: number | null;
  target: number | null;
  reason: string | null;
  error: string | null;
  pnl: number | null;
  fees: number | null;
};

const API_BASE = process.env.NEXT_PUBLIC_MONITOR_API ?? 'http://localhost:8787';

export function getHealth(): Promise<HealthPayload> {
  return fetchJson<HealthPayload>('/health');
}

export function getEvents(limit = 1000): Promise<EventRecord[]> {
  return fetchJson<EventRecord[]>(`/events?limit=${limit}`);
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}
