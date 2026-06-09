import { Hyperliquid, type ClearinghouseState, type Meta, type OrderRequest, type OrderResponse } from 'hyperliquid';
import { config } from '../../config';
import { type TraderAccount, closedTradeFromExit, positionFromSignal } from './account';
import type { TraderStore } from './store';
import type {
  CloseOrderRequest,
  CloseOrderResult,
  Executor,
  LiveClosedTrade,
  LiveFill,
  LivePosition,
  OpenOrderRequest,
  OpenOrderResult,
} from './types';

type TestnetSecret = {
  TESTNET_AGENT_KEY?: string;
  TESTNET_ACCOUNT_ADDRESS?: string;
};

type AssetRules = {
  name: string;
  szDecimals: number;
};

type FrontendOpenOrder = {
  coin: string;
  isPositionTpsl?: boolean;
  isTrigger?: boolean;
  limitPx?: string;
  oid: number;
  orderType?: string;
  origSz?: string;
  reduceOnly?: boolean;
  side?: string;
  sz?: string;
  timestamp?: number;
  triggerCondition?: string;
  triggerPx?: string;
};

type ExchangePosition = ClearinghouseState['assetPositions'][number]['position'];

type UserFill = {
  closedPnl: string;
  coin: string;
  dir: string;
  fee: string;
  oid: number;
  px: string;
  side: string;
  startPosition: string;
  sz: string;
  time: number;
};

const TESTNET_SLIPPAGE = 0.003;

export class TestnetExecutor implements Executor {
  readonly mode = 'TESTNET' as const;
  private meta: Meta | null = null;
  private readonly loggedRules = new Set<string>();

  private constructor(
    private readonly sdk: Hyperliquid,
    private readonly accountAddress: string,
  ) {}

  static async create(): Promise<TestnetExecutor> {
    const secret = await loadTestnetSecret();
    const key = secret.TESTNET_AGENT_KEY?.trim();
    const accountAddress = secret.TESTNET_ACCOUNT_ADDRESS?.trim();
    if (!key || key === '0x...') {
      throw new Error('TESTNET mode requires TESTNET_AGENT_KEY in gitignored trader.secret.ts.');
    }
    if (!accountAddress || accountAddress === '0x...') {
      throw new Error('TESTNET mode with an agent wallet requires TESTNET_ACCOUNT_ADDRESS in trader.secret.ts.');
    }

    const sdk = new Hyperliquid({
      privateKey: key,
      testnet: true,
      walletAddress: accountAddress,
      enableWs: false,
      disableAssetMapRefresh: false,
    });
    await sdk.ensureInitialized();
    if (!sdk.getBaseUrl().includes('hyperliquid-testnet')) {
      throw new Error(`Refusing to start TESTNET executor on non-testnet URL: ${sdk.getBaseUrl()}`);
    }
    return new TestnetExecutor(sdk, accountAddress);
  }

  async openPosition(request: OpenOrderRequest): Promise<OpenOrderResult> {
    const symbol = toPerpSymbol(request.signal.coin);
    const rules = await this.rulesFor(request.signal.coin);
    const isBuy = request.signal.direction === 'LONG';
    const size = formatSize(request.allocation.notional / request.candle.close, rules.szDecimals);
    if (Number(size) <= 0) {
      return { accepted: false, reason: `Rounded size is zero for ${request.signal.coin}` };
    }

    await this.sdk.exchange.updateLeverage(symbol, 'isolated', config.portfolio.leverage);
    const entryLimit = formatPrice(protectivePrice(request.candle.close, isBuy));
    const entryOrder: OrderRequest = {
      coin: symbol,
      is_buy: isBuy,
      sz: size,
      limit_px: entryLimit,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    };
    const stopOrder: OrderRequest = {
      coin: symbol,
      is_buy: !isBuy,
      sz: size,
      limit_px: formatPrice(request.signal.stop),
      order_type: { trigger: { isMarket: true, triggerPx: formatPrice(request.signal.stop), tpsl: 'sl' } },
      reduce_only: true,
    };
    const targetOrder: OrderRequest = {
      coin: symbol,
      is_buy: !isBuy,
      sz: size,
      limit_px: formatPrice(request.signal.target),
      order_type: { trigger: { isMarket: true, triggerPx: formatPrice(request.signal.target), tpsl: 'tp' } },
      reduce_only: true,
    };
    const entryResponse = await this.sdk.exchange.placeOrder({
      orders: [entryOrder, stopOrder, targetOrder],
      grouping: 'normalTpsl',
    });
    logOrderResponse('normalTpsl grouped', request.signal.coin, entryResponse);
    const fill = acceptedFill(entryResponse);
    if (!fill) {
      return rejectedOrder('TESTNET entry rejected or did not fill', entryResponse);
    }

    const stopResponse = singleStatusResponse(entryResponse, 1);
    logTriggerResponse('stop', request.signal.coin, stopResponse);
    const targetResponse = singleStatusResponse(entryResponse, 2);
    logTriggerResponse('target', request.signal.coin, targetResponse);

    const triggerProtection = await this.resolveTriggerProtection({
      coin: request.signal.coin,
      stop: request.signal.stop,
      target: request.signal.target,
      stopResponse,
      targetResponse,
    });
    if (!triggerProtection.protected) {
      console.error('TESTNET trigger order rejected or not resting', {
        stopOid: triggerProtection.stopOid,
        targetOid: triggerProtection.targetOid,
        stopError: triggerProtection.stopError,
        targetError: triggerProtection.targetError,
        openOrders: triggerProtection.openOrders,
      });
      await this.cancelOrder(symbol, triggerProtection.stopOid);
      await this.cancelOrder(symbol, triggerProtection.targetOid);
      await this.closeFilledEntryIfUnprotected({
        symbol,
        coin: request.signal.coin,
        entryWasBuy: isBuy,
        size: fill.totalSz,
        referencePrice: request.candle.close,
        rules,
        stop: request.signal.stop,
        target: request.signal.target,
      });
      return {
        accepted: false,
        reason: `TESTNET trigger order rejected or not resting${triggerProtection.failureReason ? `: ${triggerProtection.failureReason}` : ''}`,
        raw: { stopResponse, targetResponse, triggerProtection },
      };
    }

    const exchangePosition = await this.findExchangePosition(request.signal.coin);
    const entryPrice = exchangePosition?.entryPx ? Number(exchangePosition.entryPx) : Number(fill.avgPx);
    const position = positionFromSignal({
      signal: request.signal,
      allocation: request.allocation,
      entryPrice,
      currentPrice: request.candle.close,
      stopOrderId: triggerProtection.stopOid,
      targetOrderId: triggerProtection.targetOid,
    });
    position.quantity = Math.abs(Number(exchangePosition?.szi ?? fill.totalSz));
    position.notional = Number(exchangePosition?.positionValue ?? position.notional);
    position.margin = Number(exchangePosition?.marginUsed ?? position.margin);
    position.unrealizedPnl = Number(exchangePosition?.unrealizedPnl ?? position.unrealizedPnl);

    return {
      accepted: true,
      position,
      fill: fillFromOrder({
        coin: request.signal.coin,
        side: isBuy ? 'BUY' : 'SELL',
        time: Date.now(),
        price: Number(fill.avgPx),
        quantity: Number(fill.totalSz),
        kind: 'ENTRY',
        raw: entryResponse,
      }),
    };
  }

  async closePosition(request: CloseOrderRequest): Promise<CloseOrderResult> {
    const symbol = toPerpSymbol(request.position.coin);
    await this.cancelOrder(symbol, request.position.stopOrderId);
    await this.cancelOrder(symbol, request.position.targetOrderId);

    const isBuy = request.position.direction === 'SHORT';
    const closeResponse = await this.sdk.exchange.placeOrder({
      coin: symbol,
      is_buy: isBuy,
      sz: formatSize(request.position.quantity, (await this.rulesFor(request.position.coin)).szDecimals),
      limit_px: formatPrice(protectivePrice(request.candle.close, isBuy)),
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: true,
    });
    const fill = acceptedFill(closeResponse);
    if (!fill) {
      return rejectedOrder('TESTNET close rejected or did not fill', closeResponse);
    }

    const exchangePosition = await this.findExchangePosition(request.position.coin);
    if (exchangePosition && Math.abs(Number(exchangePosition.szi)) > 0) {
      return { accepted: false, reason: 'TESTNET close filled but exchange still reports an open position', raw: closeResponse };
    }

    const closedTrade = closedTradeFromExit({
      position: request.position,
      exit: request.exit,
      exitPrice: Number(fill.avgPx),
    });
    closedTrade.exitReason = 'TESTNET_RECONCILED';
    return {
      accepted: true,
      closedTrade,
      fill: fillFromOrder({
        coin: request.position.coin,
        side: isBuy ? 'BUY' : 'SELL',
        time: Date.now(),
        price: Number(fill.avgPx),
        quantity: Number(fill.totalSz),
        kind: request.exit.reason === 'TARGET' ? 'TP' : 'SL',
        raw: closeResponse,
      }),
    };
  }

  async reconcile() {
    await this.sdk.info.perpetuals.getClearinghouseState(this.accountAddress);
  }

  async reconcileLiveState(account: TraderAccount, store: TraderStore) {
    const state: ClearinghouseState = await this.sdk.info.perpetuals.getClearinghouseState(this.accountAddress);
    const openOrders = await this.sdk.info.getFrontendOpenOrders(this.accountAddress, true) as FrontendOpenOrder[];
    const fills = await this.recentUserFills();
    const exchangePositions = state.assetPositions
      .map((item) => item.position)
      .filter((position) => Math.abs(Number(position.szi)) > 0);
    const exchangeByCoin = new Map(exchangePositions.map((position) => [plainCoin(position.coin), position]));
    const localPositions = [...account.positions.values()];

    for (const exchangePosition of exchangePositions) {
      const coin = plainCoin(exchangePosition.coin);
      const local = account.positions.get(coin) ?? store.getOpenPositions().find((position) => position.coin === coin);
      const protective = protectiveOrdersForCoin(openOrders, coin, local?.stop, local?.target);
      const mirrored = mirrorExchangePosition({
        coin,
        exchangePosition,
        local,
        protective,
        fills,
        storedFees: local ? store.sumFillFees(coin, local.entryTime - 60_000) : 0,
      });
      account.positions.set(coin, mirrored);
      store.upsertPosition(mirrored);
    }

    for (const local of localPositions) {
      if (exchangeByCoin.has(local.coin)) continue;
      await this.cancelProtectiveOrdersForCoin(local.coin, openOrders);
      const closed = closedTradeFromExchangeFlat(local, fills);
      account.positions.delete(local.coin);
      store.deletePosition(local.coin);
      store.saveClosedTrade(closed);
      console.log(`[trader] reconciled ${local.coin}: exchange is flat, moved local position to closed trades pnl=${closed.pnl.toFixed(2)}`);
    }

    const accountValue = numeric(state.marginSummary?.accountValue, config.portfolio.startingCapital);
    const usedMargin = numeric(state.marginSummary?.totalMarginUsed, 0);
    const unrealized = sum([...account.positions.values()].map((position) => position.unrealizedPnl));
    account.realizedBalance = accountValue - unrealized;
    store.saveEquityPoint({
      time: Date.now(),
      mode: 'TESTNET',
      equity: accountValue,
      realizedBalance: account.realizedBalance,
      usedMargin,
      activePositions: account.positions.size,
    });
  }

  private async rulesFor(coin: string): Promise<AssetRules> {
    this.meta ??= await this.sdk.info.perpetuals.getMeta();
    const plain = plainCoin(coin);
    const item = this.meta.universe.find((asset) => plainCoin(asset.name) === plain);
    if (!item) throw new Error(`No TESTNET metadata for ${coin}; refusing to place order.`);
    if (!this.loggedRules.has(plain)) {
      this.loggedRules.add(plain);
      console.log(`[trader] TESTNET metadata ${coin}: sdkName=${item.name} plain=${plain} szDecimals=${item.szDecimals}`);
    }
    return item;
  }

  private async findExchangePosition(coin: string) {
    const state: ClearinghouseState = await this.sdk.info.perpetuals.getClearinghouseState(this.accountAddress);
    const plain = plainCoin(coin);
    return state.assetPositions
      .map((item) => item.position)
      .find((position) => plainCoin(position.coin) === plain && Math.abs(Number(position.szi)) > 0);
  }

  private async cancelOrder(symbol: string, orderId?: string | null) {
    if (!orderId) return;
    const numeric = Number(orderId);
    if (!Number.isFinite(numeric)) return;
    try {
      await this.sdk.exchange.cancelOrder({ coin: symbol, o: numeric });
    } catch (error) {
      console.error(`TESTNET cancel failed for ${symbol} ${orderId}:`, error instanceof Error ? error.message : error);
    }
  }

  private async cancelProtectiveOrdersForCoin(coin: string, openOrders: FrontendOpenOrder[]) {
    const symbol = toPerpSymbol(coin);
    for (const order of protectiveOrdersForCoin(openOrders, coin).all) {
      await this.cancelOrder(symbol, oidText(order.oid));
    }
  }

  private async recentUserFills(): Promise<UserFill[]> {
    try {
      return await this.sdk.info.getUserFills(this.accountAddress, true) as UserFill[];
    } catch (error) {
      console.error('[trader] TESTNET fill history unavailable during reconcile:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  private async resolveTriggerProtection(params: {
    coin: string;
    stop: number;
    target: number;
    stopResponse: unknown;
    targetResponse: unknown;
  }) {
    const stopError = orderStatusError(params.stopResponse);
    const targetError = orderStatusError(params.targetResponse);
    const openOrders = await this.findProtectiveOrders(params.coin, params.stop, params.target);
    const stopOid = acceptedOrderId(params.stopResponse) ?? oidText(openOrders.stop?.oid);
    const targetOid = acceptedOrderId(params.targetResponse) ?? oidText(openOrders.target?.oid);
    const protectedOnExchange = Boolean(openOrders.stop && openOrders.target);
    const responseAccepted = Boolean(stopOid && targetOid && !stopError && !targetError);

    if (protectedOnExchange) {
      console.log(
        `[trader] TESTNET protective triggers resting for ${params.coin}: stopOid=${oidText(openOrders.stop?.oid)} targetOid=${oidText(openOrders.target?.oid)}`,
      );
    }

    return {
      protected: protectedOnExchange || responseAccepted,
      stopOid,
      targetOid,
      stopError,
      targetError,
      failureReason: stopError ?? targetError ?? (!stopOid ? 'missing stop oid' : !targetOid ? 'missing target oid' : null),
      openOrders: openOrders.all,
    };
  }

  private async findProtectiveOrders(coin: string, stop: number, target: number) {
    const orders = await this.sdk.info.getFrontendOpenOrders(this.accountAddress, true) as FrontendOpenOrder[];
    return protectiveOrdersForCoin(orders, coin, stop, target);
  }

  private async closeFilledEntryIfUnprotected(params: {
    symbol: string;
    coin: string;
    entryWasBuy: boolean;
    size: string;
    referencePrice: number;
    rules: AssetRules;
    stop: number;
    target: number;
  }) {
    const openOrders = await this.findProtectiveOrders(params.coin, params.stop, params.target);
    if (openOrders.stop && openOrders.target) {
      console.log(
        `[trader] TESTNET orphan-close skipped for ${params.coin}: protective triggers are resting stopOid=${openOrders.stop.oid} targetOid=${openOrders.target.oid}`,
      );
      return;
    }

    await this.cancelOrder(params.symbol, oidText(openOrders.stop?.oid));
    await this.cancelOrder(params.symbol, oidText(openOrders.target?.oid));
    try {
      const closeResponse = await this.sdk.exchange.placeOrder({
        coin: params.symbol,
        is_buy: !params.entryWasBuy,
        sz: formatSize(Number(params.size), params.rules.szDecimals),
        limit_px: formatPrice(protectivePrice(params.referencePrice, !params.entryWasBuy)),
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: true,
      });
      const closeFill = acceptedFill(closeResponse);
      if (!closeFill) {
        console.error(`TESTNET orphan entry close for ${params.symbol} rejected or did not fill`, closeResponse);
        return;
      }
      console.log(`[trader] TESTNET orphan entry closed for ${params.symbol}: size=${closeFill.totalSz} avgPx=${closeFill.avgPx}`);
    } catch (error) {
      console.error(`TESTNET orphan entry close failed for ${params.symbol}:`, error instanceof Error ? error.message : error);
    }
  }
}

export async function loadTestnetSecret(secretPath = new URL('../../trader.secret.ts', import.meta.url).pathname): Promise<TestnetSecret> {
  try {
    return await import(secretPath) as TestnetSecret;
  } catch (error) {
    throw new Error(
      `TESTNET mode requires gitignored trader.secret.ts with TESTNET_AGENT_KEY and TESTNET_ACCOUNT_ADDRESS. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function toPerpSymbol(coin: string): string {
  if (coin.includes(':')) {
    throw new Error(`TESTNET executor supports plain Hyperliquid perps only, received ${coin}.`);
  }
  return `${coin}-PERP`;
}

export function plainCoin(coin: string): string {
  return coin.includes('-PERP') ? coin.slice(0, -5) : coin;
}

function protectivePrice(price: number, isBuy: boolean): number {
  return price * (isBuy ? 1 + TESTNET_SLIPPAGE : 1 - TESTNET_SLIPPAGE);
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid TESTNET price: ${price}`);
  return Number(price.toPrecision(5)).toString();
}

export function formatSize(size: number, szDecimals: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0';
  const factor = 10 ** szDecimals;
  return (Math.floor(size * factor) / factor).toFixed(szDecimals).replace(/\.?0+$/, '');
}

function acceptedFill(response: OrderResponse | unknown): { oid: number; totalSz: string; avgPx: string } | null {
  const order = response as OrderResponse;
  if (order.status !== 'ok') return null;
  for (const status of order.response?.data?.statuses ?? []) {
    if (status.filled) return status.filled;
  }
  return null;
}

export function acceptedOrderId(response: OrderResponse | unknown): string | null {
  const order = response as OrderResponse;
  if (!order || order.status !== 'ok') return null;
  for (const status of order.response?.data?.statuses ?? []) {
    if (status.resting?.oid) return String(status.resting.oid);
    if (status.filled?.oid) return String(status.filled.oid);
    const nestedOid = findNestedOid(status);
    if (nestedOid) return nestedOid;
  }
  return null;
}

export function orderStatusError(response: unknown): string | null {
  const order = response as OrderResponse;
  if (!order || order.status !== 'ok') return `top-level status ${String(order?.status)}`;
  for (const status of order.response?.data?.statuses ?? []) {
    if (typeof status === 'string') return statusStringError(status);
    const error = findNestedError(status);
    if (error) return error;
  }
  return null;
}

function statusStringError(status: string): string | null {
  const normalized = status.toLowerCase();
  if (normalized === 'waitingfortrigger' || normalized === 'resting' || normalized === 'filled') return null;
  return status;
}

function findNestedOid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'oid' && (typeof item === 'number' || typeof item === 'string')) return String(item);
    const nested = findNestedOid(item);
    if (nested) return nested;
  }
  return null;
}

function findNestedError(value: unknown): string | null {
  if (typeof value === 'string') return null;
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'error' && typeof item === 'string') return item;
    const nested = findNestedError(item);
    if (nested) return nested;
  }
  return null;
}

function logTriggerResponse(kind: 'stop' | 'target', coin: string, response: unknown) {
  console.log(`[trader] TESTNET ${kind} trigger response for ${coin}: ${safeStringify(response)}`);
}

function logOrderResponse(kind: string, coin: string, response: unknown) {
  console.log(`[trader] TESTNET ${kind} response for ${coin}: ${safeStringify(response)}`);
}

function singleStatusResponse(response: unknown, index: number): OrderResponse | unknown {
  const order = response as OrderResponse;
  const status = order.response?.data?.statuses?.[index];
  return {
    status: order.status,
    response: {
      type: order.response?.type ?? 'order',
      data: {
        statuses: status === undefined ? [] : [status],
      },
    },
  };
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function oidText(oid: number | string | null | undefined): string | null {
  return oid === null || oid === undefined ? null : String(oid);
}

function matchesTriggerPrice(order: FrontendOpenOrder, price: number): boolean {
  if (!order.triggerPx) return false;
  return Number(order.triggerPx) === Number(formatPrice(price));
}

function triggerText(order: FrontendOpenOrder): string {
  return `${order.orderType ?? ''} ${order.triggerCondition ?? ''}`.toLowerCase();
}

function protectiveOrdersForCoin(orders: FrontendOpenOrder[], coin: string, stop?: number, target?: number) {
  const plain = plainCoin(coin);
  const protectiveOrders = orders.filter((order) => (
    plainCoin(order.coin) === plain &&
    order.isTrigger === true &&
    order.reduceOnly === true
  ));
  const stopOrder = stop !== undefined
    ? protectiveOrders.find((order) => matchesTriggerPrice(order, stop))
    : undefined;
  const targetOrder = target !== undefined
    ? protectiveOrders.find((order) => matchesTriggerPrice(order, target))
    : undefined;
  return {
    stop: stopOrder ?? protectiveOrders.find((order) => triggerText(order).includes('stop')),
    target: targetOrder ?? protectiveOrders.find((order) => triggerText(order).includes('take profit') || triggerText(order).includes('tp')),
    all: protectiveOrders,
  };
}

function mirrorExchangePosition(params: {
  coin: string;
  exchangePosition: ExchangePosition;
  local?: LivePosition;
  protective: { stop?: FrontendOpenOrder; target?: FrontendOpenOrder };
  fills: UserFill[];
  storedFees: number;
}): LivePosition {
  const { coin, exchangePosition, local, protective, fills, storedFees } = params;
  const signedSize = numeric(exchangePosition.szi, 0);
  const quantity = Math.abs(signedSize);
  const notional = numeric(exchangePosition.positionValue, 0);
  const markPrice = quantity > 0 ? notional / quantity : local?.currentPrice ?? numeric(exchangePosition.entryPx, 0);
  const entryTime = local?.entryTime ?? latestOpenFillTime(coin, fills) ?? Date.now();
  const fees = exchangeFeesForCoinSince(coin, entryTime - 60_000, fills) || storedFees || local?.fees || 0;
  return {
    coin,
    mode: 'TESTNET',
    direction: signedSize >= 0 ? 'LONG' : 'SHORT',
    strategy: local?.strategy ?? 'RANGE_REVERSION',
    regime: local?.regime ?? 'RANGE',
    entryTime,
    entry: numeric(exchangePosition.entryPx, local?.entry ?? 0),
    stop: triggerPrice(protective.stop) ?? local?.stop ?? 0,
    target: triggerPrice(protective.target) ?? local?.target ?? 0,
    score: local?.score ?? 0,
    margin: numeric(exchangePosition.marginUsed, local?.margin ?? 0),
    notional,
    allocationPct: local?.allocationPct ?? 0,
    riskAtStop: local?.riskAtStop ?? 0,
    quantity,
    currentPrice: markPrice,
    unrealizedPnl: numeric(exchangePosition.unrealizedPnl, 0),
    markPrice,
    liquidationPrice: numericOrNull(exchangePosition.liquidationPx),
    fees,
    stopOrderId: oidText(protective.stop?.oid) ?? local?.stopOrderId ?? null,
    targetOrderId: oidText(protective.target?.oid) ?? local?.targetOrderId ?? null,
  };
}

function closedTradeFromExchangeFlat(position: LivePosition, fills: UserFill[]): LiveClosedTrade {
  const relevant = fills
    .filter((fill) => plainCoin(fill.coin) === position.coin && fill.time >= position.entryTime - 60_000);
  const closing = relevant.filter((fill) => Math.abs(numeric(fill.closedPnl, 0)) > 0);
  const exitTime = Math.max(...closing.map((fill) => fill.time), Date.now());
  const exitPrice = weightedFillPrice(closing) ?? position.currentPrice;
  const fees = sum(relevant.map((fill) => Math.abs(numeric(fill.fee, 0)))) || position.fees || 0;
  const pnlFromExchange = closing.length > 0
    ? sum(closing.map((fill) => numeric(fill.closedPnl, 0))) - sum(closing.map((fill) => Math.abs(numeric(fill.fee, 0))))
    : position.unrealizedPnl;
  return {
    ...position,
    currentPrice: exitPrice,
    markPrice: exitPrice,
    unrealizedPnl: 0,
    fees,
    exitTime,
    exitPrice,
    exitReason: inferExitReason(position, exitPrice),
    pnl: pnlFromExchange,
    returnOnMargin: position.margin > 0 ? pnlFromExchange / position.margin : 0,
  };
}

function inferExitReason(position: LivePosition, exitPrice: number): LiveClosedTrade['exitReason'] {
  const tolerance = 0.001;
  if (position.direction === 'LONG') {
    if (position.target > 0 && exitPrice >= position.target * (1 - tolerance)) return 'TARGET';
    if (position.stop > 0 && exitPrice <= position.stop * (1 + tolerance)) return 'STOP';
  } else {
    if (position.target > 0 && exitPrice <= position.target * (1 + tolerance)) return 'TARGET';
    if (position.stop > 0 && exitPrice >= position.stop * (1 - tolerance)) return 'STOP';
  }
  return 'TESTNET_RECONCILED';
}

function latestOpenFillTime(coin: string, fills: UserFill[]): number | null {
  const openFills = fills.filter((fill) => (
    plainCoin(fill.coin) === coin &&
    Math.abs(numeric(fill.closedPnl, 0)) === 0 &&
    triggerTextFromFill(fill).includes('open')
  ));
  if (openFills.length === 0) return null;
  return Math.max(...openFills.map((fill) => fill.time));
}

function triggerTextFromFill(fill: UserFill): string {
  return `${fill.dir ?? ''}`.toLowerCase();
}

function exchangeFeesForCoinSince(coin: string, since: number, fills: UserFill[]): number {
  return sum(fills
    .filter((fill) => plainCoin(fill.coin) === coin && fill.time >= since)
    .map((fill) => Math.abs(numeric(fill.fee, 0))));
}

function weightedFillPrice(fills: UserFill[]): number | null {
  const totalSize = sum(fills.map((fill) => Math.abs(numeric(fill.sz, 0))));
  if (totalSize <= 0) return null;
  return sum(fills.map((fill) => Math.abs(numeric(fill.sz, 0)) * numeric(fill.px, 0))) / totalSize;
}

function triggerPrice(order?: FrontendOpenOrder): number | null {
  return order?.triggerPx ? numericOrNull(order.triggerPx) : null;
}

function numeric(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numericOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function rejectedOrder(reason: string, raw: unknown): OpenOrderResult {
  console.error(reason, raw);
  return { accepted: false, reason, raw };
}

function fillFromOrder(params: {
  coin: string;
  side: LiveFill['side'];
  time: number;
  price: number;
  quantity: number;
  kind: LiveFill['kind'];
  raw: unknown;
}): LiveFill {
  return {
    coin: params.coin,
    mode: 'TESTNET',
    time: params.time,
    side: params.side,
    price: params.price,
    quantity: params.quantity,
    notional: params.price * params.quantity,
    fee: 0,
    kind: params.kind,
    raw: JSON.stringify(params.raw).slice(0, 2000),
  };
}
