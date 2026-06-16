import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, type TraderMode } from '../../config';
import type { IndicatorSnapshot } from '../core/indicators';
import type { StrategySignal } from '../core/strategy';
import type { Candle, Direction, StrategyName } from '../core/types';
import type { LiveClosedTrade, LiveDecision, LiveFill, LivePosition } from './types';
import type { HealthPayload } from './health';

type ConsoleMethod = (...args: unknown[]) => void;
type TradeEventType = 'HEARTBEAT' | 'SIGNAL' | 'ORDER_ATTEMPT' | 'OPEN' | 'CLOSE' | 'ERROR' | 'SKIP';

export type EntryIndicators = {
  adx: number | null;
  rsi: number | null;
  atr: number | null;
  fastEma: number | null;
  slowEma: number | null;
  emaSlope: number | null;
  regime: string | null;
  ready: boolean;
};

export type OpenTradeContext = {
  signal: StrategySignal;
  position: LivePosition;
  candle: Candle;
  indicators: EntryIndicators;
  equityBefore: number;
  equityAfter: number;
  usedMargin: number;
  openPositionsCount: number;
  entryFee: number;
  orderId?: string | null;
  exchangeOrderId?: string | null;
};

type StoredTradeContext = OpenTradeContext & {
  tradeId: string;
  signalId: string;
  positionId: string;
  openedAt: number;
};

type EventInput = {
  event: TradeEventType;
  tradeId?: string;
  symbol: string | null;
  direction?: Direction | null;
  strategy?: StrategyName | null;
  status: string;
  price?: number | null;
  size?: number | null;
  stop?: number | null;
  target?: number | null;
  reason?: string | null;
  skip_reason?: string | null;
  error?: string | null;
  pnl?: number | null;
  fees?: number | null;
  signalId?: string | null;
  orderId?: string | null;
  exchangeOrderId?: string | null;
  positionId?: string | null;
  payload?: Record<string, unknown>;
};

const LOG_DIR = 'logs';
const TIMEFRAME = '5m';

export class TraderLogger {
  private readonly tradeLogPath: string;
  private readonly manifestPath: string;
  private readonly textLogPrefix: string;
  private readonly openContexts = new Map<string, StoredTradeContext>();
  private readonly tradeIdsBySignal = new Map<string, string>();
  private readonly heartbeatTradeId = randomUUID();
  private nextEventId: number;
  private originalLog: ConsoleMethod | null = null;
  private originalError: ConsoleMethod | null = null;
  private consoleInstalled = false;
  private writingConsole = false;

  constructor(private readonly mode: TraderMode = config.trader.mode, logDir = LOG_DIR) {
    this.tradeLogPath = mode === 'TESTNET' ? `${logDir}/events.TESTNET.jsonl` : `${logDir}/trades-PAPER.jsonl`;
    this.manifestPath = mode === 'TESTNET' ? `${logDir}/events.TESTNET.manifest.json` : `${logDir}/trades-PAPER.manifest.json`;
    this.textLogPrefix = `${logDir}/${mode}`;
    this.nextEventId = loadNextEventId(this.tradeLogPath);
    this.writeManifest();
  }

  installConsoleCapture() {
    if (this.consoleInstalled) return;
    this.consoleInstalled = true;
    this.originalLog = console.log.bind(console);
    this.originalError = console.error.bind(console);
    console.log = (...args: unknown[]) => {
      this.originalLog?.(...args);
      this.writeTextLine(args.map(formatConsoleArg).join(' '));
    };
    console.error = (...args: unknown[]) => {
      this.originalError?.(...args);
      this.writeTextLine(`[error] ${args.map(formatConsoleArg).join(' ')}`);
    };
  }

  restoreConsole() {
    if (!this.consoleInstalled) return;
    if (this.originalLog) console.log = this.originalLog;
    if (this.originalError) console.error = this.originalError;
    this.consoleInstalled = false;
  }

  text(message: string, payload?: unknown) {
    this.writeTextLine(payload === undefined ? message : `${message} ${safeStringify(payload)}`);
  }

  signal(signal: StrategySignal, indicators: EntryIndicators, candle: Candle) {
    const id = signalId(signal);
    const tradeId = this.tradeIdsBySignal.get(id) ?? randomUUID();
    this.tradeIdsBySignal.set(id, tradeId);
    this.text(`[signal] ${signal.coin} ${signal.direction} ${signal.strategy} score=${signal.score ?? 0}`, {
      signalId: id,
      levelName: signal.levelName,
      levelPrice: signal.levelPrice,
      regime: signal.regime,
      indicators,
      candle,
    });
    this.appendEvent({
      event: 'SIGNAL',
      tradeId,
      symbol: signal.coin,
      direction: signal.direction,
      strategy: signal.strategy,
      status: 'GENERATED',
      price: signal.entry,
      size: null,
      stop: signal.stop,
      target: signal.target,
      reason: 'STRATEGY_SIGNAL',
      signalId: id,
      payload: {
        score: signal.score ?? 0,
        levelName: signal.levelName,
        levelPrice: signal.levelPrice,
        regime: signal.regime,
        indicators,
        candle,
      },
    });
  }

  decision(decision: LiveDecision, signal?: StrategySignal) {
    this.text(
      `[decision] ${decision.coin} ${decision.status} ${decision.reason} score=${decision.score} margin=${decision.margin.toFixed(2)} notional=${decision.notional.toFixed(2)}`,
    );
    const id = signal ? signalId(signal) : `${decision.coin}:${decision.time}:${decision.direction}:${decision.strategy}`;
    const tradeId = this.tradeIdsBySignal.get(id) ?? randomUUID();
    this.tradeIdsBySignal.set(id, tradeId);
    if (this.mode === 'TESTNET') {
      this.appendEvent({
        event: 'ORDER_ATTEMPT',
        tradeId,
        symbol: decision.coin,
        direction: decision.direction,
        strategy: decision.strategy,
        status: decision.status,
        price: signal?.entry ?? null,
        size: null,
        stop: signal?.stop ?? null,
        target: signal?.target ?? null,
        reason: decision.reason,
        signalId: id,
        payload: {
          score: decision.score,
          margin: decision.margin,
          notional: decision.notional,
          allocationPct: decision.allocationPct,
          riskAtStop: decision.riskAtStop,
        },
      });
    }
    if (decision.status !== 'SKIPPED' && decision.status !== 'REJECTED') return;
    this.appendEvent({
      event: 'SKIP',
      tradeId,
      symbol: decision.coin,
      direction: decision.direction,
      strategy: decision.strategy,
      status: decision.status,
      price: signal?.price ?? null,
      size: 0,
      stop: signal?.stop ?? null,
      target: signal?.target ?? null,
      reason: decision.reason,
      skip_reason: decision.reason,
      signalId: id,
      payload: {
        score: decision.score,
        margin: decision.margin,
        notional: decision.notional,
        allocationPct: decision.allocationPct,
        riskAtStop: decision.riskAtStop,
        levelName: signal?.levelName ?? null,
        levelPrice: signal?.levelPrice ?? null,
      },
    });
  }

  orderAccepted(signal: StrategySignal, position: LivePosition) {
    const id = signalId(signal);
    const tradeId = position.tradeId ?? this.tradeIdsBySignal.get(id) ?? randomUUID();
    this.tradeIdsBySignal.set(id, tradeId);
    this.appendEvent({
      event: 'ORDER_ATTEMPT',
      tradeId,
      symbol: position.coin,
      direction: position.direction,
      strategy: position.strategy,
      status: 'ACCEPTED',
      price: position.entry,
      size: position.quantity,
      stop: position.stop,
      target: position.target,
      reason: 'OPENED',
      signalId: id,
      positionId: position.positionId ?? null,
      payload: {
        margin: position.margin,
        notional: position.notional,
        allocationPct: position.allocationPct,
        riskAtStop: position.riskAtStop,
      },
    });
  }

  identities(signal: StrategySignal, position: LivePosition) {
    const id = signalId(signal);
    const tradeId = this.tradeIdsBySignal.get(id) ?? randomUUID();
    this.tradeIdsBySignal.set(id, tradeId);
    return {
      tradeId,
      signalId: id,
      positionId: position.positionId ?? positionId(position),
    };
  }

  heartbeat(payload: HealthPayload) {
    this.appendEvent({
      event: 'HEARTBEAT',
      tradeId: this.heartbeatTradeId,
      symbol: null,
      status: payload.ok ? 'HEALTHY' : 'UNHEALTHY',
      reason: payload.ok ? 'HEARTBEAT' : payload.lastError ?? 'HEALTH_CHECK_FAILED',
      payload: {
        mode: payload.mode,
        traderRunning: payload.traderRunning,
        traderProcessCount: payload.traderProcessCount,
        feedSocketStatus: payload.feedSocketStatus,
        heartbeatAgeSec: payload.heartbeatAgeSec,
        equity: payload.equity,
        usedMargin: payload.usedMargin,
        secretPresent: payload.secretPresent,
      },
    });
  }

  fill(fill: LiveFill) {
    this.text(
      `[fill] ${fill.coin} ${fill.kind} ${fill.side} price=${fill.price} qty=${fill.quantity} fee=${fill.fee}`,
    );
  }

  error(message: string, context: {
    coin?: string | null;
    direction?: Direction | null;
    strategy?: StrategyName | null;
    price?: number | null;
    stop?: number | null;
    target?: number | null;
    signalId?: string | null;
    tradeId?: string | null;
  } = {}) {
    this.appendEvent({
      event: 'ERROR',
      tradeId: context.tradeId ?? randomUUID(),
      symbol: context.coin ?? null,
      direction: context.direction ?? null,
      strategy: context.strategy ?? null,
      status: 'ERROR',
      price: context.price ?? null,
      size: null,
      stop: context.stop ?? null,
      target: context.target ?? null,
      reason: message,
      error: message,
      signalId: context.signalId ?? null,
    });
  }

  tradeOpened(context: OpenTradeContext) {
    const id = signalId(context.signal);
    const tradeId = context.position.tradeId ?? this.tradeIdsBySignal.get(id) ?? randomUUID();
    this.tradeIdsBySignal.set(id, tradeId);
    const stored: StoredTradeContext = {
      ...context,
      tradeId,
      signalId: context.position.signalId ?? id,
      positionId: context.position.positionId ?? positionId(context.position),
      openedAt: Date.now(),
    };
    this.openContexts.set(context.position.coin, stored);
    this.appendEvent(openEvent(stored));
  }

  tradeClosed(closedTrade: LiveClosedTrade, exitFee: number | null) {
    const context = this.openContexts.get(closedTrade.coin) ?? contextFromClosedTrade(closedTrade);
    this.openContexts.delete(closedTrade.coin);
    this.appendEvent(closeEvent(context, closedTrade, exitFee ?? Math.max(0, (closedTrade.fees ?? 0) - context.entryFee)));
  }

  private appendEvent(input: EventInput) {
    const ts = Date.now();
    const record = {
      eventId: this.nextEventId++,
      ts,
      type: input.event,
      event: input.event,
      tradeId: input.tradeId ?? randomUUID(),
      symbol: input.symbol,
      venue: this.mode,
      timeframe: TIMEFRAME,
      direction: input.direction ?? null,
      strategy: input.strategy ?? null,
      status: input.status,
      price: input.price ?? null,
      size: input.size ?? null,
      stop: input.stop ?? null,
      target: input.target ?? null,
      reason: input.reason ?? null,
      skip_reason: input.skip_reason ?? null,
      error: input.error ?? null,
      pnl: input.pnl ?? null,
      fees: input.fees ?? null,
      source: config.trader.botName,
      bot_name: config.trader.botName,
      signalId: input.signalId ?? null,
      orderId: input.orderId ?? null,
      exchangeOrderId: input.exchangeOrderId ?? null,
      positionId: input.positionId ?? null,
      ...(input.payload ?? {}),
      mode: this.mode,
    };
    this.safeWrite(this.tradeLogPath, `${safeStringify(record)}\n`);
    this.writeManifest();
  }

  private writeTextLine(message: string) {
    if (this.writingConsole) return;
    const timestamp = new Date().toISOString();
    const path = `${this.textLogPrefix}-${timestamp.slice(0, 10)}.log`;
    this.safeWrite(path, `${timestamp} ${message}\n`);
  }

  private safeWrite(path: string, text: string) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, text);
    } catch (error) {
      this.writingConsole = true;
      try {
        (this.originalError ?? console.error.bind(console))(
          `[trader] logging failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.writingConsole = false;
      }
    }
  }

  private writeManifest() {
    try {
      mkdirSync(dirname(this.manifestPath), { recursive: true });
      writeFileSync(this.manifestPath, `${safeStringify({
        mode: this.mode,
        activeTradeLog: this.tradeLogPath,
        textLogPattern: `${this.textLogPrefix}-YYYY-MM-DD.log`,
        nextEventId: this.nextEventId,
        updatedAt: Date.now(),
      })}\n`);
    } catch (error) {
      this.writingConsole = true;
      try {
        (this.originalError ?? console.error.bind(console))(
          `[trader] logging manifest failed for ${this.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.writingConsole = false;
      }
    }
  }
}

export function entryIndicators(
  snapshot: IndicatorSnapshot | null,
  previousForSlope: IndicatorSnapshot | null,
): EntryIndicators {
  return {
    adx: finiteOrNull(snapshot?.adx),
    rsi: finiteOrNull(snapshot?.rsi),
    atr: finiteOrNull(snapshot?.atr),
    fastEma: finiteOrNull(snapshot?.emaFast),
    slowEma: finiteOrNull(snapshot?.emaSlow),
    emaSlope: snapshot && previousForSlope ? finiteOrNull(snapshot.emaSlow - previousForSlope.emaSlow) : null,
    regime: snapshot?.regime ?? null,
    ready: snapshot?.ready ?? false,
  };
}

function openEvent(context: StoredTradeContext): EventInput {
  const { position, signal } = context;
  const riskPerUnit = Math.abs(position.entry - position.stop);
  return {
    event: 'OPEN',
    tradeId: context.tradeId,
    symbol: position.coin,
    direction: position.direction,
    strategy: position.strategy,
    status: 'OPEN',
    price: position.entry,
    size: position.quantity,
    stop: position.stop,
    target: position.target,
    reason: 'OPEN',
    fees: context.entryFee,
    signalId: context.signalId,
    orderId: context.orderId ?? null,
    exchangeOrderId: context.exchangeOrderId ?? null,
    positionId: context.positionId,
    payload: {
      coin: position.coin,
      mode: position.mode,
      regime: position.regime,
      signalTime: signal.candleCloseTime,
      entryTime: position.entryTime,
      exitTime: null,
      entry: position.entry,
      exitPrice: null,
      exitReason: 'OPEN',
      riskPerUnit,
      rMultiple: null,
      returnPct: null,
      durationCandles: null,
      quantity: position.quantity,
      notional: position.notional,
      margin: position.margin,
      allocationPct: position.allocationPct,
      leverage: config.portfolio.leverage,
      entryFee: context.entryFee,
      exitFee: null,
      totalFees: context.entryFee,
      realizedPnl: null,
      indicators: context.indicators,
      score: position.score,
      levelName: signal.levelName,
      levelPrice: signal.levelPrice,
      equityBefore: context.equityBefore,
      equityAfter: context.equityAfter,
      usedMargin: context.usedMargin,
      openPositionsCount: context.openPositionsCount,
      candle: context.candle,
    },
  };
}

function closeEvent(context: StoredTradeContext, closedTrade: LiveClosedTrade, exitFee: number): EventInput {
  const riskPerUnit = Math.abs(closedTrade.entry - closedTrade.stop);
  const netPerUnit = closedTrade.quantity > 0 ? closedTrade.pnl / closedTrade.quantity : null;
  const rMultiple = netPerUnit !== null && riskPerUnit > 0 ? netPerUnit / riskPerUnit : null;
  const returnPct = netPerUnit !== null && closedTrade.entry > 0 ? netPerUnit / closedTrade.entry : null;
  const durationCandles = Math.max(0, Math.round((closedTrade.exitTime - context.signal.candleCloseTime) / (5 * 60 * 1000)));
  const totalFees = context.entryFee + exitFee;
  return {
    event: 'CLOSE',
    tradeId: context.tradeId,
    symbol: closedTrade.coin,
    direction: closedTrade.direction,
    strategy: closedTrade.strategy,
    status: 'CLOSED',
    price: closedTrade.exitPrice,
    size: closedTrade.quantity,
    stop: closedTrade.stop,
    target: closedTrade.target,
    reason: closedTrade.exitReason,
    pnl: closedTrade.pnl,
    fees: totalFees,
    signalId: context.signalId,
    orderId: context.orderId ?? null,
    exchangeOrderId: context.exchangeOrderId ?? null,
    positionId: context.positionId,
    payload: {
      coin: closedTrade.coin,
      mode: closedTrade.mode,
      regime: closedTrade.regime,
      signalTime: context.signal.candleCloseTime,
      entryTime: closedTrade.entryTime,
      exitTime: closedTrade.exitTime,
      entry: closedTrade.entry,
      exitPrice: closedTrade.exitPrice,
      exitReason: closedTrade.exitReason,
      riskPerUnit,
      rMultiple,
      returnPct,
      durationCandles,
      quantity: closedTrade.quantity,
      notional: closedTrade.notional,
      margin: closedTrade.margin,
      allocationPct: closedTrade.allocationPct,
      leverage: config.portfolio.leverage,
      entryFee: context.entryFee,
      exitFee,
      totalFees,
      realizedPnl: closedTrade.pnl,
    },
  };
}

function contextFromClosedTrade(closedTrade: LiveClosedTrade): StoredTradeContext {
  const signal = {
    type: 'CONFIRMED_SIGNAL',
    coin: closedTrade.coin,
    side: closedTrade.direction === 'LONG' ? 'SUPPORT' : 'RESISTANCE',
    levelName: 'rangeLow',
    levelPrice: 0,
    candleCloseTime: closedTrade.entryTime,
    price: closedTrade.entry,
    direction: closedTrade.direction,
    entry: closedTrade.entry,
    stop: closedTrade.stop,
    target: closedTrade.target,
    score: closedTrade.score,
    strategy: closedTrade.strategy,
    regime: closedTrade.regime,
    notified: false,
  } satisfies StrategySignal;
  const tradeId = closedTrade.tradeId ?? randomUUID();
  return {
    signal,
    position: closedTrade,
    candle: {
      openTime: closedTrade.entryTime,
      closeTime: closedTrade.entryTime,
      open: closedTrade.entry,
      high: closedTrade.entry,
      low: closedTrade.entry,
      close: closedTrade.entry,
      volume: 0,
    },
    indicators: entryIndicators(null, null),
    equityBefore: 0,
    equityAfter: 0,
    usedMargin: closedTrade.margin,
    openPositionsCount: 0,
    entryFee: closedTrade.fees ?? 0,
    tradeId,
    signalId: closedTrade.signalId ?? signalId(signal),
    positionId: closedTrade.positionId ?? positionId(closedTrade),
    openedAt: closedTrade.entryTime,
  };
}

function signalId(signal: StrategySignal): string {
  return [
    signal.coin,
    signal.candleCloseTime,
    signal.direction,
    signal.strategy,
    signal.levelName,
    signal.levelPrice,
  ].join(':');
}

function positionId(position: Pick<LivePosition, 'mode' | 'coin' | 'entryTime'>): string {
  return `${position.mode}:${position.coin}:${position.entryTime}`;
}

function loadNextEventId(path: string): number {
  if (!existsSync(path)) return 1;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = JSON.parse(lines[index]) as { eventId?: unknown };
      if (typeof parsed.eventId === 'number' && Number.isFinite(parsed.eventId)) return parsed.eventId + 1;
    }
  } catch {
    return 1;
  }
  return 1;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  return safeStringify(value) ?? String(value);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}
