import { config } from '../../config';
import { calculateIndicatorSeries, latestIndicatorAt, type IndicatorSnapshot } from '../core/indicators';
import { computeLevels } from '../core/levels';
import { RegimeAwareStrategyEngine } from '../core/strategy';
import type { Candle, Levels, MarketEvent } from '../core/types';
import { TraderAccount, updatePositionMark } from './account';
import { PaperExecutor } from './paper';
import { calculateLiveAllocation } from './sizing';
import { TraderFeed } from './feed';
import { entryIndicators, TraderLogger } from './logger';
import { TraderStore } from './store';
import { TestnetExecutor } from './testnet';
import type { CandleFeedSource, Executor, LiveDecision, LiveHeartbeat } from './types';
import { runPaperDemo } from './paper-demo';

const DAY_MS = 24 * 60 * 60 * 1000;

export class LiveTrader {
  private readonly engines = new Map<string, RegimeAwareStrategyEngine>();
  private readonly activeLevels = new Map<string, Levels>();
  private readonly recentEvents = new Map<string, MarketEvent[]>();
  private signalsSeen = 0;
  private lastAction = 'none';
  private lastError: string | null = null;

  constructor(
    private readonly store: TraderStore,
    private readonly account: TraderAccount,
    private readonly executor: Executor,
    private readonly logger: TraderLogger,
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

  async handleClosedCandle(coin: string, interval: string, candle: Candle, source: CandleFeedSource = 'WS') {
    try {
      await this.handleClosedCandleUnsafe(coin, interval, candle, source);
    } catch (error) {
      this.recordError(`handler ${coin} ${interval}: ${errorMessage(error)}`);
    }
  }

  private async handleClosedCandleUnsafe(coin: string, interval: string, candle: Candle, source: CandleFeedSource = 'WS') {
    this.store.saveCandles(coin, interval, [candle]);
    if (interval === config.trader.tradeInterval) {
      this.lastAction = `none (${source} ${coin} ${interval} ${new Date(candle.closeTime).toISOString()})`;
    }
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

    const t = liveTraderTuning();
    const regimeInterval = config.regimeForTrade['5m'];
    const recentCandles = this.store.getRecentCandles(coin, '5m', 100);
    const regimeCandles = this.store.getRecentCandles(coin, regimeInterval, 100);
    const indicatorSeries = calculateIndicatorSeries(regimeCandles, t.regime);
    const regime = latestIndicatorAt(indicatorSeries, candle.closeTime);
    const previousForSlope = previousIndicatorForSlope(indicatorSeries, regime, t.regime.slowEmaSlopeLookback);
    const indicators = entryIndicators(regime, previousForSlope);
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
    this.signalsSeen += update.signals.length;
    if (update.signals.length > 0) {
      this.lastAction = `signal ${coin} x${update.signals.length}`;
    }
    for (const signal of update.signals) {
      this.logger.signal(signal, indicators, candle);
    }

    for (const exit of update.exits) {
      const position = this.account.positions.get(coin);
      if (!position) {
        console.log(`[trader] ${coin} engine exit ${exit.reason}, no live position to close`);
        this.resetEngine(coin);
        continue;
      }
      const result = await this.safeClosePosition({ position, exit, candle });
      if (!result.accepted || !result.closedTrade) {
        this.recordError(`${coin} close rejected: ${result.reason ?? 'unknown'}`);
        this.resetEngine(coin);
        continue;
      }
      this.account.close(result.closedTrade);
      this.store.deletePosition(coin);
      this.store.saveClosedTrade(result.closedTrade);
      if (result.fill) {
        this.store.saveFill(result.fill);
        this.logger.fill(result.fill);
      }
      this.logger.tradeClosed(result.closedTrade, result.fill?.fee ?? null);
      console.log(`[trader] closed ${coin} ${result.closedTrade.exitReason} pnl=${result.closedTrade.pnl.toFixed(2)}`);
      this.lastAction = `exit ${coin} ${result.closedTrade.exitReason}`;
    }

    for (const signal of update.signals) {
      if (this.account.hasPosition(signal.coin)) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'ACTIVE_SYMBOL'), signal);
        continue;
      }
      if (this.account.positions.size >= config.trader.maxOpenPositions) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'MAX_POSITIONS'), signal);
        continue;
      }

      const equityBefore = this.account.equity();
      const usedMarginBefore = this.account.usedMargin();
      const allocation = calculateLiveAllocation({
        equity: equityBefore,
        usedMargin: usedMarginBefore,
        entry: signal.entry,
        stop: signal.stop,
        direction: signal.direction,
      });
      const reason = allocation.status === 'REJECTED'
        ? 'NO_MARGIN'
        : allocation.status === 'PARTIAL' ? 'PARTIAL_MARGIN' : 'ALLOCATED';
      this.saveDecision(decisionFromSignal(signal, allocation.status, reason, allocation), signal);
      if (allocation.status === 'REJECTED') continue;

      const result = await this.safeOpenPosition({ signal, allocation, candle });
      if (!result.accepted || !result.position) {
        this.saveDecision(decisionFromSignal(signal, 'SKIPPED', 'EXECUTOR_REJECTED', allocation), signal);
        this.recordError(`${coin} open rejected: ${result.reason ?? 'unknown'}`);
        this.resetEngine(coin);
        continue;
      }
      this.account.open(result.position);
      this.store.upsertPosition(result.position);
      if (result.fill) {
        this.store.saveFill(result.fill);
        this.logger.fill(result.fill);
      }
      this.logger.tradeOpened({
        signal,
        position: result.position,
        candle,
        indicators,
        equityBefore,
        equityAfter: this.account.equity(),
        usedMargin: this.account.usedMargin(),
        openPositionsCount: this.account.positions.size,
        entryFee: result.fill?.fee ?? 0,
        orderId: result.fill?.orderId ?? null,
        exchangeOrderId: result.position.stopOrderId ?? result.position.targetOrderId ?? null,
      });
      console.log(`[trader] opened ${coin} ${signal.direction} ${signal.strategy} margin=${allocation.margin.toFixed(2)}`);
      this.lastAction = `entry ${coin} ${signal.direction} ${signal.strategy}`;
    }

    this.store.saveEquityPoint(this.account.equityPoint(candle.closeTime));
    await this.executor.reconcile?.();
  }

  private computeLevels(coin: string) {
    const t = liveTraderTuning();
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

  private saveDecision(decision: LiveDecision, signal?: Parameters<TraderLogger['decision']>[1]) {
    this.store.saveDecision(decision);
    this.logger.decision(decision, signal);
  }

  private async safeOpenPosition(request: Parameters<Executor['openPosition']>[0]) {
    try {
      return await this.executor.openPosition(request);
    } catch (error) {
      return {
        accepted: false,
        reason: errorMessage(error),
        raw: error,
      };
    }
  }

  private async safeClosePosition(request: Parameters<Executor['closePosition']>[0]) {
    try {
      return await this.executor.closePosition(request);
    } catch (error) {
      return {
        accepted: false,
        reason: errorMessage(error),
        raw: error,
      };
    }
  }

  private resetEngine(coin: string) {
    this.engines.set(coin, new RegimeAwareStrategyEngine());
  }

  private recordError(message: string) {
    this.lastError = message;
    this.logger.error(message);
    console.error(`[trader] ${message}`);
  }

  recordExternalError(message: string) {
    this.recordError(message);
  }

  signalCount() {
    return this.signalsSeen;
  }

  lastActionText() {
    return this.lastAction;
  }

  lastErrorText() {
    return this.lastError;
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
  const logger = new TraderLogger(config.trader.mode);
  logger.installConsoleCapture();
  logTraderCoinSelection();
  logLiveTuning();
  if (!config.trader.enabled) {
    console.log('[trader] disabled by config.trader.enabled=false; no live loop started.');
    logger.restoreConsole();
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
  const trader = new LiveTrader(store, account, executor, logger);
  const feed = new TraderFeed(store, {
    onClosedCandle: (coin, interval, candle, source) => trader.handleClosedCandle(coin, interval, candle, source),
    onCurrentPrice: (coin, price) => account.mark(coin, price),
    onHealth: (heartbeat) => store.saveHeartbeat(enrichedHeartbeat(heartbeat, trader, account)),
    onLog: (message) => console.log(message),
  });

  await feed.backfillStartup();
  trader.computeStartupLevels();
  scheduleUtcRolloverLog();
  feed.start();
  console.log(`[trader] ${config.trader.mode} loop running on 5m for ${config.trader.coins.join(', ')}`);
  let heartbeatRunning = false;
  const publishHeartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      if (executor instanceof TestnetExecutor) {
        await executor.reconcileLiveState(account, store, logger);
      }
      const heartbeat = enrichedHeartbeat(feed.health(), trader, account);
      store.saveHeartbeat(heartbeat);
      logHeartbeat(heartbeat);
    } catch (error) {
      trader.recordExternalError(`reconcile: ${errorMessage(error)}`);
      const heartbeat = enrichedHeartbeat(feed.health(), trader, account);
      store.saveHeartbeat(heartbeat);
      logHeartbeat(heartbeat);
    } finally {
      heartbeatRunning = false;
    }
  };
  const heartbeatTimer = setInterval(() => {
    void publishHeartbeat();
  }, config.trader.heartbeatSeconds * 1000);
  await publishHeartbeat();

  process.on('SIGINT', () => {
    clearInterval(heartbeatTimer);
    feed.stop();
    store.close();
    logger.restoreConsole();
    process.exit(0);
  });
}

function enrichedHeartbeat(
  heartbeat: LiveHeartbeat,
  trader: LiveTrader,
  account: TraderAccount,
): LiveHeartbeat {
  return {
    ...heartbeat,
    signalsSeen: trader.signalCount(),
    openPositions: account.positions.size,
    lastAction: trader.lastActionText(),
    lastError: trader.lastErrorText(),
  };
}

function logHeartbeat(heartbeat: LiveHeartbeat) {
  const since = heartbeat.secondsSinceLastMessage === null
    ? 'never'
    : `${heartbeat.secondsSinceLastMessage}s ago`;
  const counters = Object.entries(heartbeat.closedCandlesByInterval)
    .map(([interval, count]) => `${interval}=${count}`)
    .join(' ');
  const lastClosed = Object.entries(heartbeat.lastClosedCandleByCoin)
    .map(([coin, time]) => `${coin}:${time ? formatHeartbeatTimestamp(time) : '--'}`)
    .join(' ');
  console.log(
    `[heartbeat] now=${new Date(heartbeat.time).toISOString()} uptime=${heartbeat.uptimeSeconds}s socket=${
      heartbeat.socketHealthy ? 'healthy' : 'stale'
    } lastMsg=${since} feed=${heartbeat.feedPath} candles{${counters}} signals=${
      heartbeat.signalsSeen
    } open=${heartbeat.openPositions} lastAction=${heartbeat.lastAction}`,
  );
  if (heartbeat.lastError) {
    console.log(`[heartbeat] lastError ${heartbeat.lastError}`);
  }
  console.log(`[heartbeat] lastClosed ${lastClosed}`);
}

function formatHeartbeatTimestamp(timestamp: number) {
  return new Date(timestamp).toISOString().slice(5, 16).replace('T', ' ');
}

function logTraderCoinSelection() {
  const included = config.trader.coinSelection.filter((item) => item.included);
  const skipped = config.trader.coinSelection.filter((item) => !item.included);
  console.log(`[trader] included coins (${included.length}): ${included.map((item) => item.coin).join(', ') || 'none'}`);
  if (skipped.length === 0) {
    console.log('[trader] skipped coins: none');
    return;
  }
  console.log(`[trader] skipped coins (${skipped.length}):`);
  for (const item of skipped) {
    console.log(`[trader] - ${item.coin}: ${item.reason}`);
  }
}

function liveTraderTuning() {
  return config.trader.tuning ?? config.tuning['5m'];
}

function logLiveTuning() {
  const t = liveTraderTuning();
  console.log('[trader] live tuning override:', {
    adxThreshold: t.regime.adxThreshold,
    rangeMaxAdx: t.range.maxAdx,
    rangeMinScore: t.range.minScore,
    touchTolerance: t.touchTolerance,
    touchCooldownMinutes: t.touchCooldownMinutes,
    confirmWithinCandles: t.confirmWithinCandles,
    breakoutLookback: t.trend.breakoutLookback,
    rsiLongMin: t.trend.rsiLongMin,
    rsiShortMax: t.trend.rsiShortMax,
    targetR: { range: t.range.targetR, trend: t.trend.targetR },
  });
}

function previousIndicatorForSlope(
  series: IndicatorSnapshot[],
  current: IndicatorSnapshot | null,
  lookback: number,
): IndicatorSnapshot | null {
  if (!current) return null;
  const index = series.findIndex((item) => item.candleCloseTime === current.candleCloseTime);
  return index >= lookback ? series[index - lookback] : null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await main();
}
