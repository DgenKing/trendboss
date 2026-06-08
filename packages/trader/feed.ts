import { config } from '../../config';
import type { Candle } from '../core/types';
import { fetchCandles, HyperliquidSocket } from '../monitor/hyperliquid';
import type { TraderStore } from './store';

export type TraderFeedHandlers = {
  onClosedCandle: (coin: string, interval: string, candle: Candle) => void | Promise<void>;
  onCurrentPrice: (coin: string, price: number) => void;
  onHealth: (healthy: boolean) => void;
  onLog?: (message: string) => void;
};

export class TraderFeed {
  private socket: HyperliquidSocket | null = null;
  private nextRestRequestAt = 0;

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
    this.socket = new HyperliquidSocket(
      {
        wsUrl: traderWsUrl(),
        coins: [...config.trader.coins],
        intervals: traderIntervals(),
        staleSocketSeconds: config.staleSocketSeconds,
      },
      this.handlers,
    );
    this.socket.start();
  }

  stop() {
    this.socket?.stop();
  }

  private async backfillInterval(coin: string, interval: string) {
    const endTime = Date.now();
    const intervalMs = intervalToMs(interval);
    const target = config.backfillTarget[interval] ?? 5000;
    const existingCount = this.store.countCandles(coin, interval);
    const lastCandleTime = this.store.getLastCandleTime(coin, interval);
    const startTime = existingCount < target || lastCandleTime === null
      ? endTime - target * intervalMs
      : Math.max(0, lastCandleTime - intervalMs);
    const estimatedCandles = Math.min(target + 1, Math.max(1, Math.ceil((endTime - startTime) / intervalMs)));
    await this.waitForRestBudget(estimatedCandles);
    const candles = await fetchCandles({
      restUrl: traderRestInfoUrl(),
      coin,
      interval,
      startTime,
      endTime,
    });
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
