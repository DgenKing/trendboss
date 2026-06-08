import { config } from '../../config';
import { calculateIndicatorSeries, latestIndicatorAt } from '../core/indicators';
import { computeLevels } from '../core/levels';
import { RegimeAwareStrategyEngine } from '../core/strategy';
import type { Candle, Levels, MarketEvent } from '../core/types';
import { TraderAccount, updatePositionMark } from './account';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation } from './sizing';
import { TraderFeed } from './feed';
import { TraderStore } from './store';
import { TestnetExecutor } from './testnet';
import type { Executor, LiveDecision } from './types';
import { runPaperDemo } from './paper-demo';

const DAY_MS = 24 * 60 * 60 * 1000;

export class LiveTrader {
  private readonly engines = new Map<string, RegimeAwareStrategyEngine>();
  private readonly activeLevels = new Map<string, Levels>();
  private readonly recentEvents = new Map<string, MarketEvent[]>();

  constructor(
    private readonly store: TraderStore,
    private readonly account: TraderAccount,
    private readonly executor: Executor,
  ) {
    for (const coin of config.trader.coins) {
      this.engines.set(coin, new RegimeAwareStrategyEngine());
    }
  }

  computeStartupLevels() {
    for (const coin of config.trader.coins) {
      this.computeLevels(coin);
    }
  }

  async handleClosedCandle(coin: string, interval: string, candle: Candle) {
    this.store.saveCandles(coin, interval, [candle]);
    if (interval === '1d') {
      this.computeLevels(coin);
      return;
    }
    if (interval !== config.trader.tradeInterval) return;

    const marked = this.account.positions.get(coin);
    if (marked) {
      const next = updatePositionMark(marked, candle);
      this.account.positions.set(coin, next);
      this.store.upsertPosition(next);
    }

    const levels = this.activeLevels.get(coin);
    if (!levels) {
      console.log(`[trader] ${coin} skipped: no daily levels ready`);
      return;
    }

    const t = config.tuning['5m'];
    const regimeInterval = config.regimeForTrade['5m'];
    const recentCandles = this.store.getRecentCandles(coin, '5m', 100);
    const regimeCandles = this.store.getRecentCandles(coin, regimeInterval, 100);
    const regime = latestIndicatorAt(calculateIndicatorSeries(regimeCandles, t.regime), candle.closeTime);
    const engine = this.engines.get(coin);
    if (!engine) return;

    const update = engine.update({
      candle,
      levels,
      recentCandles,
      recentEvents: this.recentEvents.get(coin) ?? [],
      regime,
      options: {
        detection: {
          touchTolerance: t.touchTolerance,
          touchCooldownMinutes: t.touchCooldownMinutes,
        },
        rangeSignal: {
          confirmWithinCandles: t.confirmWithinCandles,
          stopBuffer: t.stopBuffer,
        },
        range: t.range,
        trend: t.trend,
      },
    });
    this.rememberEvents(coin, [...update.events, ...update.signals]);

    for (const exit of update.exits) {
      const position = this.account.positions.get(coin);
      if (!position) {
        console.log(`[trader] ${coin} engine exit ${exit.reason}, no live position to close`);
        continue;
      }
      const result = await this.executor.closePosition({ position, exit, candle });
      if (!result.accepted || !result.closedTrade) {
        console.error(`[trader] ${coin} close rejected: ${result.reason ?? 'unknown'}`);
        continue;
      }
      this.account.close(result.closedTrade);
      this.store.deletePosition(coin);
      this.store.saveClosedTrade(result.closedTrade);
      if (result.fill) this.store.saveFill(result.fill);
      console.log(`[trader] closed ${coin} ${result.closedTrade.exitReason} pnl=${result.closedTrade.pnl.toFixed(2)}`);
    }

    for (const signal of update.signals) {
      if (this.account.hasPosition(signal.coin)) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'ACTIVE_SYMBOL'));
        continue;
      }
      if (this.account.positions.size >= config.trader.maxOpenPositions) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'MAX_POSITIONS'));
        continue;
      }

      const allocation = calculateLiveAllocation({
        equity: this.account.equity(),
        usedMargin: this.account.usedMargin(),
        entry: signal.entry,
        stop: signal.stop,
        direction: signal.direction,
      });
      const reason = allocation.status === 'REJECTED'
        ? 'NO_MARGIN'
        : allocation.status === 'PARTIAL' ? 'PARTIAL_MARGIN' : 'ALLOCATED';
      this.saveDecision(decisionFromSignal(signal, allocation.status, reason, allocation));
      if (allocation.status === 'REJECTED') continue;

      const result = await this.executor.openPosition({ signal, allocation, candle });
      if (!result.accepted || !result.position) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'EXECUTOR_REJECTED', allocation));
        console.error(`[trader] ${coin} open rejected: ${result.reason ?? 'unknown'}`);
        continue;
      }
      this.account.open(result.position);
      this.store.upsertPosition(result.position);
      if (result.fill) this.store.saveFill(result.fill);
      console.log(`[trader] opened ${coin} ${signal.direction} ${signal.strategy} margin=${allocation.margin.toFixed(2)}`);
    }

    this.store.saveEquityPoint(this.account.equityPoint(candle.closeTime));
    await this.executor.reconcile?.();
  }

  private computeLevels(coin: string) {
    const t = config.tuning['5m'];
    const dailyCandles = this.store.getRecentCandles(coin, '1d', config.backfillTarget['1d']);
    try {
      const levels = computeLevels(dailyCandles, {
        coin,
        now: Date.now(),
        swingLookbackDays: t.swingLookbackDays,
        pivotWindow: t.pivotWindow,
        swingMinDistancePct: t.swingMinDistancePct,
      });
      this.activeLevels.set(coin, levels);
    } catch (error) {
      console.error(`[trader] Level compute failed for ${coin}:`, error instanceof Error ? error.message : error);
    }
  }

  private rememberEvents(coin: string, events: MarketEvent[]) {
    if (events.length === 0) return;
    this.recentEvents.set(coin, [...(this.recentEvents.get(coin) ?? []), ...events].slice(-200));
  }

  private saveDecision(decision: LiveDecision) {
    this.store.saveDecision(decision);
  }
}

export async function main() {
  if (process.argv.includes('--demo-paper')) {
    await runPaperDemo();
    return;
  }
  if (config.trader.tradeInterval !== '5m') {
    throw new Error('Trader supports 5m only.');
  }
  if (!config.trader.enabled) {
    console.log('[trader] disabled by config.trader.enabled=false; no live loop started.');
    return;
  }

  const store = new TraderStore();
  const account = new TraderAccount({
    realizedBalance: store.getLatestEquityPoint()?.realizedBalance,
    positions: store.getOpenPositions(),
  });
  const executor = config.trader.mode === 'TESTNET'
    ? await TestnetExecutor.create()
    : new PaperExecutor();
  const trader = new LiveTrader(store, account, executor);
  const feed = new TraderFeed(store, {
    onClosedCandle: (coin, interval, candle) => trader.handleClosedCandle(coin, interval, candle),
    onCurrentPrice: (coin, price) => account.mark(coin, price),
    onHealth: (healthy) => store.setMeta('socketHealthy', String(healthy)),
    onLog: (message) => console.log(message),
  });

  await feed.backfillStartup();
  trader.computeStartupLevels();
  scheduleUtcRolloverLog();
  feed.start();
  console.log(`[trader] ${config.trader.mode} loop running on 5m for ${config.trader.coins.join(', ')}`);

  process.on('SIGINT', () => {
    feed.stop();
    store.close();
    process.exit(0);
  });
}

function decisionFromSignal(
  signal: { coin: string; candleCloseTime: number; direction: LiveDecision['direction']; strategy: LiveDecision['strategy']; score?: number },
  status: LiveDecision['status'],
  reason: LiveDecision['reason'],
  allocation = { margin: 0, notional: 0, allocationPct: 0, riskAtStop: 0 },
): LiveDecision {
  return {
    coin: signal.coin,
    time: signal.candleCloseTime,
    mode: config.trader.mode,
    direction: signal.direction,
    strategy: signal.strategy,
    score: signal.score ?? 0,
    status,
    reason,
    margin: allocation.margin,
    notional: allocation.notional,
    allocationPct: allocation.allocationPct,
    riskAtStop: allocation.riskAtStop,
  };
}

function scheduleUtcRolloverLog() {
  let latest = latestCompletedUtcDay();
  setInterval(() => {
    const next = latestCompletedUtcDay();
    if (next !== latest) {
      latest = next;
      console.log('[trader] UTC day rolled; daily levels will refresh when the next 1d candle closes.');
    }
  }, 60_000);
}

function latestCompletedUtcDay() {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
}

if (import.meta.main) {
  await main();
}
