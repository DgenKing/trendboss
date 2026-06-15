import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, type TraderMode } from '../../config';
import type {
  LiveHeartbeat,
  LiveOrderAttemptSummary,
  LivePosition,
  LiveSignalSummary,
} from './types';

export type HealthCoin = {
  coin: string;
  price: number | null;
  lastClosed5mCandle: number | null;
  position: LivePosition | null;
  lastSignal: LiveSignalSummary | null;
  lastOrderAttempt: LiveOrderAttemptSummary | null;
};

export type HealthPayload = {
  ok: boolean;
  mode: TraderMode;
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

export type HealthInput = {
  heartbeat: LiveHeartbeat | null;
  positions: LivePosition[];
  equity: number;
  usedMargin: number;
  lastError?: string | null;
  now?: number;
  processCount?: number;
  secretPresent?: boolean;
  mode?: TraderMode;
};

const STATUS_PATH = 'logs/status.json';

export function buildHealthPayload(input: HealthInput): HealthPayload {
  const now = input.now ?? Date.now();
  const heartbeat = input.heartbeat;
  const processCount = input.processCount ?? countTraderProcesses();
  const secretPresent = input.secretPresent ?? existsSync(resolve('trader.secret.ts'));
  const mode = input.mode ?? config.trader.mode;
  const heartbeatAgeSec = heartbeat ? Math.max(0, Math.floor((now - heartbeat.time) / 1000)) : null;
  const heartbeatStale = heartbeatAgeSec === null || heartbeatAgeSec > config.trader.heartbeatSeconds * 2 + 15;
  // Feed health is global: if the connection is alive, liquid coins keep printing 5m candles.
  // Thin testnet coins (e.g. TON) legitimately go many minutes without a candle, so requiring
  // EVERY coin to be fresh produces false "stale" alarms. Treat the feed as fresh when at least
  // one coin has printed a 5m candle within the window.
  const candleFresh = Boolean(heartbeat && config.trader.coins.some((coin) => {
    const closeTime = heartbeat.lastClosedCandleByCoin[coin];
    return closeTime !== null && closeTime !== undefined && now - closeTime <= 10 * 60 * 1000;
  }));
  const socketFresh = Boolean(
    heartbeat?.socketHealthy &&
    heartbeat.secondsSinceLastMessage !== null &&
    heartbeat.secondsSinceLastMessage <= config.staleSocketSeconds &&
    candleFresh,
  );
  const restFresh = heartbeat?.feedPath === 'REST_POLL' && candleFresh;
  const feedSocketStatus = socketFresh ? 'HEALTHY' : restFresh ? 'REST_FALLBACK' : 'STALE';
  const positions = new Map(input.positions.map((position) => [position.coin, position]));
  const coins = config.trader.coins.map((coin) => ({
    coin,
    price: heartbeat?.currentPriceByCoin?.[coin] ?? positions.get(coin)?.currentPrice ?? null,
    lastClosed5mCandle: heartbeat?.lastClosedCandleByCoin[coin] ?? null,
    position: positions.get(coin) ?? null,
    lastSignal: heartbeat?.lastSignalByCoin?.[coin] ?? null,
    lastOrderAttempt: heartbeat?.lastOrderAttemptByCoin?.[coin] ?? null,
  }));
  const traderRunning = processCount === 1;
  const lastError = input.lastError ?? heartbeat?.lastError ?? null;

  return {
    ok: mode === 'TESTNET' && traderRunning && feedSocketStatus !== 'STALE' && !heartbeatStale && secretPresent,
    mode,
    coins,
    traderRunning,
    traderProcessCount: processCount,
    feedSocketStatus,
    heartbeatAgeSec,
    equity: input.equity,
    usedMargin: input.usedMargin,
    lastError,
    secretPresent,
    updatedAt: now,
  };
}

export function writeHealthSnapshot(payload: HealthPayload, path = STATUS_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(temporary, path);
    return true;
  } catch (error) {
    console.error(`[trader] status snapshot write failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function readHealthSnapshot(path = STATUS_PATH): HealthPayload | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HealthPayload;
  } catch {
    return null;
  }
}

export function refreshHealthSnapshot(snapshot: HealthPayload | null): HealthPayload {
  const now = Date.now();
  const processCount = countTraderProcesses();
  const secretPresent = existsSync(resolve('trader.secret.ts'));
  if (!snapshot) {
    return buildHealthPayload({
      heartbeat: null,
      positions: [],
      equity: 0,
      usedMargin: 0,
      now,
      processCount,
      secretPresent,
    });
  }

  const heartbeatAgeSec = Math.max(0, Math.floor((now - snapshot.updatedAt) / 1000));
  const heartbeatStale = heartbeatAgeSec > config.trader.heartbeatSeconds * 2 + 15;
  const traderRunning = processCount === 1;
  return {
    ...snapshot,
    ok: snapshot.mode === 'TESTNET' && traderRunning && snapshot.feedSocketStatus !== 'STALE' && !heartbeatStale && secretPresent,
    traderRunning,
    traderProcessCount: processCount,
    heartbeatAgeSec,
    secretPresent,
    updatedAt: now,
  };
}

export function countTraderProcesses(): number {
  try {
    return readdirSync('/proc', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .filter((entry) => {
        try {
          const command = readFileSync(`/proc/${entry.name}/cmdline`, 'utf8').replaceAll('\0', ' ');
          return command.includes('packages/trader/index.ts');
        } catch {
          return false;
        }
      }).length;
  } catch {
    return 0;
  }
}
