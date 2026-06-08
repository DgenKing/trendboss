import { Hyperliquid, type ClearinghouseState, type Meta, type OrderResponse } from 'hyperliquid';
import { config } from '../../config';
import { closedTradeFromExit, positionFromSignal } from './account';
import type {
  CloseOrderRequest,
  CloseOrderResult,
  Executor,
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

const TESTNET_SLIPPAGE = 0.003;

export class TestnetExecutor implements Executor {
  readonly mode = 'TESTNET' as const;
  private meta: Meta | null = null;

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
    const entryResponse = await this.sdk.exchange.placeOrder({
      coin: symbol,
      is_buy: isBuy,
      sz: size,
      limit_px: entryLimit,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    const fill = acceptedFill(entryResponse);
    if (!fill) {
      return rejectedOrder('TESTNET entry rejected or did not fill', entryResponse);
    }

    const stopResponse = await this.sdk.exchange.placeOrder({
      coin: symbol,
      is_buy: !isBuy,
      sz: fill.totalSz,
      limit_px: formatPrice(request.signal.stop),
      order_type: { trigger: { isMarket: true, triggerPx: formatPrice(request.signal.stop), tpsl: 'sl' } },
      reduce_only: true,
      grouping: 'normalTpsl',
    });
    const targetResponse = await this.sdk.exchange.placeOrder({
      coin: symbol,
      is_buy: !isBuy,
      sz: fill.totalSz,
      limit_px: formatPrice(request.signal.target),
      order_type: { trigger: { isMarket: true, triggerPx: formatPrice(request.signal.target), tpsl: 'tp' } },
      reduce_only: true,
      grouping: 'normalTpsl',
    });
    const stopOid = acceptedOrderId(stopResponse);
    const targetOid = acceptedOrderId(targetResponse);
    if (!stopOid || !targetOid) {
      console.error('TESTNET trigger order rejected', { stopResponse, targetResponse });
      await this.cancelOrder(symbol, stopOid);
      await this.cancelOrder(symbol, targetOid);
      return { accepted: false, reason: 'TESTNET trigger order rejected', raw: { stopResponse, targetResponse } };
    }

    const exchangePosition = await this.findExchangePosition(request.signal.coin);
    const entryPrice = exchangePosition?.entryPx ? Number(exchangePosition.entryPx) : Number(fill.avgPx);
    const position = positionFromSignal({
      signal: request.signal,
      allocation: request.allocation,
      entryPrice,
      currentPrice: request.candle.close,
      stopOrderId: stopOid,
      targetOrderId: targetOid,
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

  private async rulesFor(coin: string): Promise<AssetRules> {
    this.meta ??= await this.sdk.info.perpetuals.getMeta();
    const plain = plainCoin(coin);
    const item = this.meta.universe.find((asset) => asset.name === plain);
    if (!item) throw new Error(`No TESTNET metadata for ${coin}; refusing to place order.`);
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
}

export async function loadTestnetSecret(): Promise<TestnetSecret> {
  const secretPath = new URL('../../trader.secret.ts', import.meta.url).pathname;
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

function plainCoin(coin: string): string {
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

function acceptedOrderId(response: OrderResponse | unknown): string | null {
  const order = response as OrderResponse;
  if (order.status !== 'ok') return null;
  for (const status of order.response?.data?.statuses ?? []) {
    if (status.resting?.oid) return String(status.resting.oid);
    if (status.filled?.oid) return String(status.filled.oid);
  }
  return null;
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
