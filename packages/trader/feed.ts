import { config } from '../../config';
import type { Candle } from '../core/types';
import { fetchCandles, parseCandle } from '../monitor/hyperliquid';
import type { TraderStore } from './store';
import type { CandleFeedSource, LiveHeartbeat } from './types';

type RawCandle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string | number;
  c: string | number;
  h: string | number;
  l: string | number;
  v: string | number;
  n: number;
};

export type TraderFeedHandlers = {
  onClosedCandle: (
    coin: string,
    interval: string,
    candle: Candle,
    source: CandleFeedSource,
  ) => void | Promise<void>;
  onCurrentPrice: (coin: string, price: number) => void;
  onHealth: (heartbeat: LiveHeartbeat) => void;
  onLog?: (message: string) => void;
};

export class TraderFeed {
  private socket: WebSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private staleTimer: Timer | null = null;
  private restPollTimer: Timer | null = null;
  private nextRestRequestAt = 0;
  private readonly startedAt = Date.now();
  private readonly processed = new Set<string>();
  private readonly closedCandlesByInterval = Object.fromEntries(
    traderIntervals().map((interval) => [interval, 0]),
  ) as Record<string, number>;
  private readonly lastClosedCandleByCoin = Object.fromEntries(
    config.trader.coins.map((coin) => [coin, null]),
  ) as Record<string, number | null>;
  private readonly rawChannels = new Map<string, number>();
  private lastRawChannel: string | null = null;
  private lastMessageAt: number | null = null;
  private socketHealthy = false;
  private reconnectAttempt = 0;
  private staleReconnects = 0;
  private wsPausedUntil = 0;
  private wsPauseLogged = false;
  private readonly liveCandles = new Map<string, Candle>();
  private lastWsCandleAt: number | null = null;
  private lastRestPollCandleAt: number | null = null;
  private polling = false;

  constructor(
    private readonly store: TraderStore,
    private readonly handlers: TraderFeedHandlers,
  ) {}

  async backfillStartup() {
    for (const interval of traderIntervals()) {
      for (const coin of config.trader.coins) {
        await this.backfillInterval(coin, interval);
      }
    }
  }

  start() {
    this.connectSocket();
    this.staleTimer = setInterval(() => this.reconnectIfStale(), 5_000);
    this.startRestPolling();
    this.emitHealth();
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.restPollTimer) clearInterval(this.restPollTimer);
    this.socket?.close();
  }

  health(overrides: Partial<Pick<LiveHeartbeat, 'signalsSeen' | 'openPositions' | 'lastAction'>> = {}): LiveHeartbeat {
    return {
      time: Date.now(),
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      socketHealthy: this.socketHealthy,
      secondsSinceLastMessage: this.lastMessageAt === null
        ? null
        : Math.floor((Date.now() - this.lastMessageAt) / 1000),
      closedCandlesByInterval: { ...this.closedCandlesByInterval },
      lastClosedCandleByCoin: { ...this.lastClosedCandleByCoin },
      signalsSeen: overrides.signalsSeen ?? 0,
      openPositions: overrides.openPositions ?? 0,
      lastAction: overrides.lastAction ?? 'none',
      lastError: null,
      feedPath: this.activeFeedPath(),
      rawChannels: Object.fromEntries(this.rawChannels),
      lastRawChannel: this.lastRawChannel,
    };
  }

  emitHealth(heartbeat?: LiveHeartbeat) {
    this.handlers.onHealth(heartbeat ?? this.health());
  }

  private connectSocket() {
    const now = Date.now();
    if (now < this.wsPausedUntil) {
      const seconds = Math.ceil((this.wsPausedUntil - now) / 1000);
      this.handlers.onLog?.(`[trader] WebSocket reconnect paused for ${seconds}s; REST poll fallback is active`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectSocket();
      }, this.wsPausedUntil - now);
      return;
    }

    this.handlers.onLog?.(
      `Opening Hyperliquid WebSocket for ${config.trader.coins.length} coins x ${traderIntervals().length} intervals`,
    );
    this.wsPauseLogged = false;
    this.socket = new WebSocket(traderWsUrl());

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.socketHealthy = true;
      this.emitHealth();
      this.subscribeSocket();
    };

    this.socket.onmessage = (message) => {
      this.lastMessageAt = Date.now();
      this.socketHealthy = true;
      this.staleReconnects = 0;
      this.handleSocketMessage(message.data);
      this.emitHealth();
    };

    this.socket.onerror = () => {
      this.socketHealthy = false;
      this.emitHealth();
    };

    this.socket.onclose = () => {
      this.socketHealthy = false;
      this.emitHealth();
      this.scheduleReconnect();
    };
  }

  private subscribeSocket() {
    for (const coin of config.trader.coins) {
      for (const interval of traderIntervals()) {
        this.sendSocket({
          method: 'subscribe',
          subscription: {
            type: 'candle',
            coin,
            interval,
          },
        });
      }
    }
    this.sendSocket({
      method: 'subscribe',
      subscription: { type: 'allMids' },
    });
  }

  private sendSocket(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private handleSocketMessage(data: string | ArrayBufferLike | Blob) {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data) as { channel?: string; data?: unknown };
    const channel = message.channel ?? 'unknown';
    this.recordRawChannel(channel);

    if (channel === 'candle') {
      const raw = message.data as RawCandle;
      this.handleSocketCandle(raw.s, raw.i, parseCandle(raw));
      return;
    }

    if (channel === 'allMids') {
      const mids = (message.data as { mids?: Record<string, string | number> })?.mids;
      if (!mids) return;
      for (const coin of config.trader.coins) {
        const raw = mids[coin];
        if (raw !== undefined) this.handlers.onCurrentPrice(coin, toNumber(raw));
      }
    }
  }

  private recordRawChannel(channel: string) {
    const count = (this.rawChannels.get(channel) ?? 0) + 1;
    this.rawChannels.set(channel, count);
    this.lastRawChannel = channel;
    if (count <= 5 || count % 100 === 0) {
      this.handlers.onLog?.(`[trader] WS channel ${channel} received (${count})`);
    }
  }

  private reconnectIfStale() {
    if (!this.socket || this.lastMessageAt === null) return;
    if (Date.now() - this.lastMessageAt <= config.staleSocketSeconds * 1000) return;

    this.staleReconnects += 1;
    this.socketHealthy = false;
    if (!this.wsPauseLogged) {
      this.handlers.onLog?.(
        `[trader] WebSocket stale: ${Math.floor((Date.now() - this.lastMessageAt) / 1000)}s since last message; REST poll fallback is active`,
      );
    }
    if (this.staleReconnects >= 3) {
      this.enterWsPause();
    }
    this.emitHealth();
    const staleSocket = this.socket;
    this.socket = null;
    staleSocket.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  }

  private enterWsPause() {
    if (Date.now() < this.wsPausedUntil && this.wsPauseLogged) return;
    this.wsPausedUntil = Date.now() + 5 * 60 * 1000;
    this.wsPauseLogged = true;
    this.handlers.onLog?.('[trader] WebSocket stayed stale after 3 checks; pausing WS reconnects for 300s to stop reconnect spam');
  }

  private startRestPolling() {
    this.handlers.onLog?.(`[trader] REST poll fallback enabled every ${config.trader.heartbeatSeconds}s`);
    void this.pollClosedCandles();
    this.restPollTimer = setInterval(
      () => void this.pollClosedCandles(),
      config.trader.heartbeatSeconds * 1000,
    );
  }

  private async pollClosedCandles() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const interval of traderIntervals()) {
        for (const coin of config.trader.coins) {
          await this.pollClosedCandlesFor(coin, interval);
        }
      }
    } finally {
      this.polling = false;
      this.emitHealth();
    }
  }

  private async pollClosedCandlesFor(coin: string, interval: string) {
    const intervalMs = intervalToMs(interval);
    const endTime = Date.now();
    const lastCandleTime = this.store.getLastCandleTime(coin, interval);
    const usableLastCandleTime = lastCandleTime !== null && lastCandleTime <= endTime ? lastCandleTime : null;
    const startTime = usableLastCandleTime === null
      ? endTime - 3 * intervalMs
      : Math.max(0, usableLastCandleTime - intervalMs);
    await this.waitForRestBudget(Math.max(1, Math.ceil((endTime - startTime) / intervalMs)));

    try {
      const candles = await fetchCandles({
        restUrl: traderRestInfoUrl(),
        coin,
        interval,
        startTime,
        endTime,
      });
      const closedCandles = candles.filter((candle) => candle.closeTime <= Date.now());
      if (closedCandles.length > 0) this.store.saveCandles(coin, interval, closedCandles);
      for (const candle of closedCandles) {
        this.handleClosedCandle(coin, interval, candle, 'REST_POLL');
      }
    } catch (error) {
      this.handlers.onLog?.(
        `[trader] REST poll failed for ${coin} ${interval}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private handleSocketCandle(coin: string, interval: string, candle: Candle) {
    this.handlers.onCurrentPrice(coin, candle.close);

    const key = `${coin}:${interval}`;
    const live = this.liveCandles.get(key);
    if (live && candle.openTime > live.openTime) {
      this.handleClosedCandle(coin, interval, live, 'WS');
      this.liveCandles.set(key, candle);
      return;
    }

    this.liveCandles.set(key, candle);
    if (Date.now() >= candle.closeTime) {
      this.handleClosedCandle(coin, interval, candle, 'WS');
    }
  }

  private handleClosedCandle(coin: string, interval: string, candle: Candle, source: CandleFeedSource) {
    const key = `${coin}:${interval}:${candle.openTime}`;
    if (this.processed.has(key)) return;
    this.processed.add(key);
    if (this.processed.size > 10_000) {
      const keep = [...this.processed].slice(-5_000);
      this.processed.clear();
      for (const item of keep) this.processed.add(item);
    }

    if (source === 'WS') {
      this.lastWsCandleAt = Date.now();
      this.wsPauseLogged = false;
      this.staleReconnects = 0;
    } else {
      this.lastRestPollCandleAt = Date.now();
    }
    this.closedCandlesByInterval[interval] = (this.closedCandlesByInterval[interval] ?? 0) + 1;
    this.lastClosedCandleByCoin[coin] = Math.max(
      this.lastClosedCandleByCoin[coin] ?? 0,
      candle.closeTime,
    );
    Promise.resolve(this.handlers.onClosedCandle(coin, interval, candle, source)).catch((error) => {
      this.handlers.onLog?.(
        `[trader] closed-candle handler failed for ${coin} ${interval}: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  private activeFeedPath(): CandleFeedSource | 'NONE' {
    const now = Date.now();
    if (
      this.socketHealthy &&
      this.lastWsCandleAt !== null &&
      now - this.lastWsCandleAt <= config.staleSocketSeconds * 1000
    ) {
      return 'WS';
    }
    if (this.lastRestPollCandleAt !== null) return 'REST_POLL';
    return 'NONE';
  }

  private async backfillInterval(coin: string, interval: string) {
    const endTime = Date.now();
    const intervalMs = intervalToMs(interval);
    const target = config.backfillTarget[interval] ?? 5000;
    const existingCount = this.store.countCandles(coin, interval);
    const lastCandleTime = this.store.getLastCandleTime(coin, interval);
    const usableLastCandleTime = lastCandleTime !== null && lastCandleTime <= endTime ? lastCandleTime : null;
    const startTime = existingCount < target || usableLastCandleTime === null
      ? endTime - target * intervalMs
      : Math.max(0, usableLastCandleTime - intervalMs);
    const estimatedCandles = Math.min(target + 1, Math.max(1, Math.ceil((endTime - startTime) / intervalMs)));
    await this.waitForRestBudget(estimatedCandles);
    const candles = (await fetchCandles({
      restUrl: traderRestInfoUrl(),
      coin,
      interval,
      startTime,
      endTime,
    })).filter((candle) => candle.closeTime <= Date.now());
    this.store.saveCandles(coin, interval, candles);
    this.handlers.onLog?.(
      `[trader] Backfilled ${coin} ${interval}: saved ${candles.length}, cached ${this.store.countCandles(coin, interval)}/${target}`,
    );
  }

  private async waitForRestBudget(estimatedCandles: number) {
    const estimatedWeight = 20 + Math.ceil(estimatedCandles / 60);
    const spacingMs = Math.max(
      config.backfillRequestSpacingMs,
      Math.ceil((estimatedWeight / config.backfillWeightBudgetPerMin) * 60_000),
    );
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRestRequestAt - now);
    this.nextRestRequestAt = Math.max(now, this.nextRestRequestAt) + spacingMs;
    if (waitMs > 0) await sleep(waitMs);
  }
}

export function traderIntervals(): string[] {
  return [config.trader.tradeInterval, config.regimeForTrade[config.trader.tradeInterval], '1d'];
}

function traderRestInfoUrl(): string {
  if (config.trader.mode !== 'TESTNET') return config.restUrl;
  return `${config.trader.testnetRestUrl.replace(/\/$/, '')}/info`;
}

function traderWsUrl(): string {
  return config.trader.mode === 'TESTNET' ? config.trader.testnetWsUrl : config.wsUrl;
}

export function intervalToMs(interval: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(interval);
  if (!match) return 5 * 60 * 1000;
  const value = Number(match[1]);
  if (match[2] === 'm') return value * 60 * 1000;
  if (match[2] === 'h') return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

function toNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric Hyperliquid value, received ${value}`);
  }
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
