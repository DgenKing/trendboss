import { Database } from 'bun:sqlite';
import { config } from '../../config';
import type { Candle } from '../core/types';
import type {
  EquityPoint,
  LiveClosedTrade,
  LiveDecision,
  LiveFill,
  LiveHeartbeat,
  LivePosition,
  LiveState,
} from './types';

export class TraderStore {
  private db: Database;
  private candleDb: Database;

  constructor(dbPath = config.trader.dbPath, candleDbPath?: string) {
    const resolvedCandleDbPath = candleDbPath ?? (dbPath === config.trader.dbPath ? config.dbPath : `${dbPath}.candles`);
    this.db = new Database(dbPath);
    this.candleDb = new Database(resolvedCandleDbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.candleDb.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  saveCandles(coin: string, interval: string, candles: Candle[]) {
    const stmt = this.candleDb.prepare(`
      INSERT INTO candles
        (coin, interval, openTime, closeTime, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin, interval, openTime) DO UPDATE SET
        closeTime = excluded.closeTime,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume
    `);
    const tx = this.candleDb.transaction((rows: Candle[]) => {
      for (const candle of rows) {
        stmt.run(
          coin,
          interval,
          candle.openTime,
          candle.closeTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        );
      }
    });
    tx(candles);
  }

  getRecentCandles(coin: string, interval: string, limit: number): Candle[] {
    const rows = this.candleDb.query(`
      SELECT openTime, closeTime, open, high, low, close, volume
      FROM candles
      WHERE coin = ? AND interval = ?
      ORDER BY openTime DESC
      LIMIT ?
    `).all(coin, interval, limit) as Candle[];
    return rows.reverse();
  }

  getLastCandleTime(coin: string, interval: string): number | null {
    const row = this.candleDb.query(`
      SELECT closeTime
      FROM candles
      WHERE coin = ? AND interval = ?
      ORDER BY openTime DESC
      LIMIT 1
    `).get(coin, interval) as { closeTime: number } | null;
    return row?.closeTime ?? null;
  }

  countCandles(coin: string, interval: string): number {
    const row = this.candleDb.query(`
      SELECT COUNT(*) AS count
      FROM candles
      WHERE coin = ? AND interval = ?
    `).get(coin, interval) as { count: number } | null;
    return row?.count ?? 0;
  }

  saveDecision(decision: LiveDecision) {
    this.db.prepare(`
      INSERT INTO live_decisions
        (coin, time, mode, direction, strategy, score, status, reason, margin,
         notional, allocationPct, riskAtStop, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.coin,
      decision.time,
      decision.mode,
      decision.direction,
      decision.strategy,
      decision.score,
      decision.status,
      decision.reason,
      decision.margin,
      decision.notional,
      decision.allocationPct,
      decision.riskAtStop,
      Date.now(),
    );
  }

  saveFill(fill: LiveFill) {
    this.db.prepare(`
      INSERT INTO live_fills
        (coin, mode, time, side, price, quantity, notional, fee, kind, orderId, raw, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fill.coin,
      fill.mode,
      fill.time,
      fill.side,
      fill.price,
      fill.quantity,
      fill.notional,
      fill.fee,
      fill.kind,
      fill.orderId ?? null,
      fill.raw ?? null,
      Date.now(),
    );
  }

  upsertPosition(position: LivePosition) {
    this.db.prepare(`
      INSERT INTO live_positions
        (coin, mode, direction, strategy, regime, entryTime, entry, stop, target,
         score, margin, notional, allocationPct, riskAtStop, quantity, currentPrice,
         unrealizedPnl, markPrice, liquidationPrice, fees, stopOrderId, targetOrderId,
         tradeId, signalId, positionId, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin) DO UPDATE SET
        mode = excluded.mode,
        direction = excluded.direction,
        strategy = excluded.strategy,
        regime = excluded.regime,
        entryTime = excluded.entryTime,
        entry = excluded.entry,
        stop = excluded.stop,
        target = excluded.target,
        score = excluded.score,
        margin = excluded.margin,
        notional = excluded.notional,
        allocationPct = excluded.allocationPct,
        riskAtStop = excluded.riskAtStop,
        quantity = excluded.quantity,
        currentPrice = excluded.currentPrice,
        unrealizedPnl = excluded.unrealizedPnl,
        markPrice = excluded.markPrice,
        liquidationPrice = excluded.liquidationPrice,
        fees = excluded.fees,
        stopOrderId = excluded.stopOrderId,
        targetOrderId = excluded.targetOrderId,
        tradeId = excluded.tradeId,
        signalId = excluded.signalId,
        positionId = excluded.positionId,
        updatedAt = excluded.updatedAt
    `).run(...positionParams(position), Date.now());
  }

  deletePosition(coin: string) {
    this.db.prepare('DELETE FROM live_positions WHERE coin = ?').run(coin);
  }

  saveClosedTrade(trade: LiveClosedTrade) {
    this.db.prepare(`
      INSERT INTO live_closed_trades
        (coin, mode, direction, strategy, regime, entryTime, entry, stop, target,
         score, margin, notional, allocationPct, riskAtStop, quantity, currentPrice,
         unrealizedPnl, markPrice, liquidationPrice, fees, stopOrderId, targetOrderId,
         tradeId, signalId, positionId, exitTime, exitPrice, exitReason,
         pnl, returnOnMargin, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...positionParams(trade), trade.exitTime, trade.exitPrice, trade.exitReason, trade.pnl, trade.returnOnMargin, Date.now());
  }

  saveEquityPoint(point: EquityPoint) {
    const existing = this.db.query(`
      SELECT id
      FROM live_equity_points
      WHERE time = ? AND mode = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(point.time, point.mode) as { id: number } | null;
    if (existing) {
      this.db.prepare(`
        UPDATE live_equity_points
        SET equity = ?, realizedBalance = ?, usedMargin = ?, activePositions = ?
        WHERE id = ?
      `).run(point.equity, point.realizedBalance, point.usedMargin, point.activePositions, existing.id);
      return;
    }
    this.db.prepare(`
      INSERT INTO live_equity_points
        (time, mode, equity, realizedBalance, usedMargin, activePositions)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(point.time, point.mode, point.equity, point.realizedBalance, point.usedMargin, point.activePositions);
  }

  setMeta(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO live_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM live_meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  saveHeartbeat(heartbeat: LiveHeartbeat) {
    this.setMeta('heartbeat', JSON.stringify(heartbeat));
  }

  getOpenPositions(): LivePosition[] {
    return this.db.query(`
      SELECT coin, mode, direction, strategy, regime, entryTime, entry, stop, target,
             score, margin, notional, allocationPct, riskAtStop, quantity, currentPrice,
             unrealizedPnl, markPrice, liquidationPrice, fees, stopOrderId, targetOrderId,
             tradeId, signalId, positionId
      FROM live_positions
      ORDER BY entryTime ASC
    `).all() as LivePosition[];
  }

  sumFillFees(coin: string, sinceTime = 0): number {
    const row = this.db.query(`
      SELECT COALESCE(SUM(fee), 0) AS fees
      FROM live_fills
      WHERE coin = ? AND time >= ?
    `).get(coin, sinceTime) as { fees: number } | null;
    return row?.fees ?? 0;
  }

  getLatestEquityPoint(): EquityPoint | null {
    return this.db.query(`
      SELECT time, mode, equity, realizedBalance, usedMargin, activePositions
      FROM live_equity_points
      ORDER BY time DESC
      LIMIT 1
    `).get() as EquityPoint | null;
  }

  getLiveState(): LiveState {
    const latest = this.getLatestEquityPoint();
    const openPositions = this.getOpenPositions();
    const heartbeat = this.getHeartbeat();
    const normalizedHeartbeat = heartbeat
      ? {
        ...heartbeat,
        openPositions: openPositions.length,
        lastError: latest && latest.time > heartbeat.time ? null : heartbeat.lastError,
      }
      : null;
    return {
      enabled: config.trader.enabled,
      mode: latest?.mode ?? config.trader.mode,
      tradeInterval: config.trader.tradeInterval,
      updatedAt: latest?.time ?? null,
      heartbeat: normalizedHeartbeat,
      equity: latest?.equity ?? config.portfolio.startingCapital,
      realizedBalance: latest?.realizedBalance ?? config.portfolio.startingCapital,
      usedMargin: latest?.usedMargin ?? 0,
      openPositions,
      closedTrades: this.db.query(`
        SELECT coin, mode, direction, strategy, regime, entryTime, entry, stop, target,
               score, margin, notional, allocationPct, riskAtStop, quantity, currentPrice,
               unrealizedPnl, markPrice, liquidationPrice, fees, stopOrderId, targetOrderId,
               tradeId, signalId, positionId, exitTime, exitPrice, exitReason,
               pnl, returnOnMargin
        FROM live_closed_trades
        ORDER BY exitTime DESC
        LIMIT 50
      `).all() as LiveClosedTrade[],
      equityPoints: (this.db.query(`
        SELECT time, mode, equity, realizedBalance, usedMargin, activePositions
        FROM live_equity_points
        ORDER BY time DESC
        LIMIT 500
      `).all() as EquityPoint[]).reverse(),
      recentDecisions: this.db.query(`
        SELECT id, coin, time, mode, direction, strategy, score, status, reason,
               margin, notional, allocationPct, riskAtStop
        FROM live_decisions
        ORDER BY time DESC, id DESC
        LIMIT 50
      `).all() as LiveDecision[],
    };
  }

  close() {
    this.db.close();
    this.candleDb.close();
  }

  private migrate() {
    this.db.exec(`
      DROP TABLE IF EXISTS trader_candles;

      CREATE TABLE IF NOT EXISTS live_positions (
        coin TEXT PRIMARY KEY,
        mode TEXT,
        direction TEXT,
        strategy TEXT,
        regime TEXT,
        entryTime INTEGER,
        entry REAL,
        stop REAL,
        target REAL,
        score REAL,
        margin REAL,
        notional REAL,
        allocationPct REAL,
        riskAtStop REAL,
        quantity REAL,
        currentPrice REAL,
        unrealizedPnl REAL,
        markPrice REAL,
        liquidationPrice REAL,
        fees REAL DEFAULT 0,
        stopOrderId TEXT,
        targetOrderId TEXT,
        tradeId TEXT,
        signalId TEXT,
        positionId TEXT,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS live_closed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT,
        mode TEXT,
        direction TEXT,
        strategy TEXT,
        regime TEXT,
        entryTime INTEGER,
        entry REAL,
        stop REAL,
        target REAL,
        score REAL,
        margin REAL,
        notional REAL,
        allocationPct REAL,
        riskAtStop REAL,
        quantity REAL,
        currentPrice REAL,
        unrealizedPnl REAL,
        markPrice REAL,
        liquidationPrice REAL,
        fees REAL DEFAULT 0,
        stopOrderId TEXT,
        targetOrderId TEXT,
        tradeId TEXT,
        signalId TEXT,
        positionId TEXT,
        exitTime INTEGER,
        exitPrice REAL,
        exitReason TEXT,
        pnl REAL,
        returnOnMargin REAL,
        createdAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS live_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT,
        time INTEGER,
        mode TEXT,
        direction TEXT,
        strategy TEXT,
        score REAL,
        status TEXT,
        reason TEXT,
        margin REAL,
        notional REAL,
        allocationPct REAL,
        riskAtStop REAL,
        createdAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS live_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT,
        mode TEXT,
        time INTEGER,
        side TEXT,
        price REAL,
        quantity REAL,
        notional REAL,
        fee REAL,
        kind TEXT,
        orderId TEXT,
        raw TEXT,
        createdAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS live_equity_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER,
        mode TEXT,
        equity REAL,
        realizedBalance REAL,
        usedMargin REAL,
        activePositions INTEGER
      );

      CREATE TABLE IF NOT EXISTS live_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this.candleDb.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        coin TEXT,
        interval TEXT,
        openTime INTEGER,
        closeTime INTEGER,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        PRIMARY KEY (coin, interval, openTime)
      );
    `);
    this.addColumn('live_positions', 'markPrice', 'REAL');
    this.addColumn('live_positions', 'liquidationPrice', 'REAL');
    this.addColumn('live_positions', 'fees', 'REAL DEFAULT 0');
    this.addColumn('live_positions', 'tradeId', 'TEXT');
    this.addColumn('live_positions', 'signalId', 'TEXT');
    this.addColumn('live_positions', 'positionId', 'TEXT');
    this.addColumn('live_closed_trades', 'markPrice', 'REAL');
    this.addColumn('live_closed_trades', 'liquidationPrice', 'REAL');
    this.addColumn('live_closed_trades', 'fees', 'REAL DEFAULT 0');
    this.addColumn('live_closed_trades', 'tradeId', 'TEXT');
    this.addColumn('live_closed_trades', 'signalId', 'TEXT');
    this.addColumn('live_closed_trades', 'positionId', 'TEXT');
  }

  private addColumn(table: string, column: string, definition: string) {
    const existing = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (existing.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private getHeartbeat(): LiveHeartbeat | null {
    const raw = this.getMeta('heartbeat');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LiveHeartbeat;
    } catch {
      return null;
    }
  }
}

type SqlValue = string | number | null;

function positionParams(position: LivePosition): SqlValue[] {
  return [
    position.coin,
    position.mode,
    position.direction,
    position.strategy,
    position.regime,
    position.entryTime,
    position.entry,
    position.stop,
    position.target,
    position.score,
    position.margin,
    position.notional,
    position.allocationPct,
    position.riskAtStop,
    position.quantity,
    position.currentPrice,
    position.unrealizedPnl,
    position.markPrice ?? position.currentPrice,
    position.liquidationPrice ?? null,
    position.fees ?? 0,
    position.stopOrderId ?? null,
    position.targetOrderId ?? null,
    position.tradeId ?? null,
    position.signalId ?? null,
    position.positionId ?? null,
  ];
}
