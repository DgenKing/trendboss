import { config } from '../../config';
import {
  closedTradeFromExit,
  paperEntryPrice,
  paperExitPrice,
  positionFromSignal,
} from './account';
import type { CloseOrderRequest, CloseOrderResult, Executor, OpenOrderRequest, OpenOrderResult } from './types';

export class PaperExecutor implements Executor {
  readonly mode = 'PAPER' as const;

  async openPosition(request: OpenOrderRequest): Promise<OpenOrderResult> {
    const price = paperEntryPrice(request.signal);
    const position = positionFromSignal({
      signal: request.signal,
      allocation: request.allocation,
      entryPrice: price,
      currentPrice: request.candle.close,
    });

    return {
      accepted: true,
      position,
      fill: {
        coin: request.signal.coin,
        mode: this.mode,
        time: request.signal.candleCloseTime,
        side: request.signal.direction === 'LONG' ? 'BUY' : 'SELL',
        price,
        quantity: position.quantity,
        notional: position.notional,
        fee: position.quantity * price * config.backtest.feePerSide,
        kind: 'ENTRY',
      },
    };
  }

  async closePosition(request: CloseOrderRequest): Promise<CloseOrderResult> {
    const exitPrice = paperExitPrice(request.position, request.exit.exitPrice);
    const closedTrade = closedTradeFromExit({
      position: request.position,
      exit: request.exit,
      exitPrice,
    });

    return {
      accepted: true,
      closedTrade,
      fill: {
        coin: request.position.coin,
        mode: this.mode,
        time: request.exit.exitTime,
        side: request.position.direction === 'LONG' ? 'SELL' : 'BUY',
        price: exitPrice,
        quantity: request.position.quantity,
        notional: request.position.quantity * exitPrice,
        fee: request.position.quantity * exitPrice * config.backtest.feePerSide,
        kind: request.exit.reason === 'TARGET' ? 'TP' : 'SL',
      },
    };
  }
}
