// Plain perps are referenced by bare symbol ("ETH").
// HIP-3 builder-deployed markets use a "dex:ASSET" form ("xyz:XYZ100", "xyz:SP500").
const DEFAULT_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'ZEC',
  'NEAR', 'WLD', 'XRP', 'TON', 'SUI', 'DOGE',
  'xyz:XYZ100', 'xyz:SP500',
];

// COINS env overrides the default list, e.g. COINS="ETH,SOL,xyz:SP500"
const coins = (process.env.COINS ?? DEFAULT_COINS.join(','))
  .split(',')
  .map(normalizeCoin)
  .filter(Boolean);

export const tradeIntervals = ['5m', '15m', '1h', '2h', '4h'] as const;
export type TradeInterval = typeof tradeIntervals[number];

export type IntervalTuning = {
  swingLookbackDays: number;
  pivotWindow: number;
  swingMinDistancePct: number;
  touchTolerance: number;
  touchCooldownMinutes: number;
  confirmWithinCandles: number;
  stopBuffer: number;
  regime: {
    adxPeriod: number;
    adxThreshold: number;
    fastEmaPeriod: number;
    slowEmaPeriod: number;
    slowEmaSlopeLookback: number;
  };
  trend: {
    breakoutLookback: number;
    atrPeriod: number;
    atrStopMultiple: number;
    targetR: number;
    rsiPeriod: number;
    rsiLongMin: number;
    rsiShortMax: number;
  };
  range: {
    enabled: boolean;
    maxAdx: number;
    targetR: number;
    minScore: number;
  };
};

export type TraderMode = 'PAPER' | 'TESTNET';

const tradeInterval = (process.env.TRADE_INTERVAL ?? '15m') as TradeInterval;
const traderMode = process.env.TRADER_MODE === 'TESTNET' ? 'TESTNET' : 'PAPER';
const traderEnabled = process.env.TRADER_ENABLED === 'true';
const TESTNET_SUPPORTED_TRADER_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'ZEC',
  'NEAR', 'WLD', 'TON', 'SUI', 'DOGE',
] as const;
const testnetSupportedTraderCoins = new Set<string>(TESTNET_SUPPORTED_TRADER_COINS);
const traderCoinSelection = coins.map((coin) => {
  if (coin.includes(':')) {
    return {
      coin,
      included: false,
      reason: 'HIP-3 dex market is not supported by the TESTNET executor',
    };
  }
  if (!testnetSupportedTraderCoins.has(coin)) {
    return {
      coin,
      included: false,
      reason: 'not listed in Hyperliquid TESTNET meta universe queried 2026-06-08',
    };
  }
  return {
    coin,
    included: true,
    reason: 'plain perp listed in Hyperliquid TESTNET meta universe',
  };
});
const traderCoins = traderCoinSelection
  .filter((item) => item.included)
  .map((item) => item.coin);
const regimeForTrade = {
  '5m': '1h',
  '15m': '1h',
  '1h': '4h',
  '2h': '4h',
  '4h': '1d',
} as const satisfies Record<TradeInterval, string>;

export const config = {
  coins,
  tradeInterval,
  tradeIntervals,
  regimeForTrade,
  candleInterval: tradeInterval,
  regimeInterval: regimeForTrade[tradeInterval],
  chartIntervals: ['5m', '15m', '1h', '2h', '4h', '1d'] as const,
  backfillTarget: {
    '5m': 5000,
    '15m': 5000,
    '1h': 5000,
    '2h': 5000,
    '4h': 5000,
    '1d': 5000,
  } as Record<string, number>,
  backfillWeightBudgetPerMin: 900,
  backfillRequestSpacingMs: 300,
  tuning: {
    // ===== 5m tuning =====
    '5m': {
      swingLookbackDays: 0,        // 0 = scroll back through ALL available history (no cap)
      pivotWindow: 2,
      swingMinDistancePct: 0.015,  // a swing must be >=1.5% beyond the range, else it's the same peak -> null
      touchTolerance: 0.0006,      // 0.06%
      touchCooldownMinutes: 60,
      confirmWithinCandles: 3,
      stopBuffer: 0.0005,
      regime: {
        adxPeriod: 14,
        adxThreshold: 38,
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        slowEmaSlopeLookback: 10,
      },
      trend: {
        breakoutLookback: 80,
        atrPeriod: 14,
        atrStopMultiple: 3.4,
        targetR: 2.2,
        rsiPeriod: 14,
        rsiLongMin: 62,
        rsiShortMax: 38,
      },
      range: {
        enabled: true,
        maxAdx: 16,
        targetR: 2.4,
        minScore: 80,
      },
    },
    // ===== 15m tuning =====
    '15m': {
      swingLookbackDays: 0,        // 0 = scroll back through ALL available history (no cap)
      pivotWindow: 2,
      swingMinDistancePct: 0.015,  // a swing must be >=1.5% beyond the range, else it's the same peak -> null
      touchTolerance: 0.0008,      // 0.08%
      touchCooldownMinutes: 60,
      confirmWithinCandles: 3,
      stopBuffer: 0.0005,
      regime: {
        adxPeriod: 14,
        adxThreshold: 22,
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        slowEmaSlopeLookback: 10,
      },
      trend: {
        breakoutLookback: 40,
        atrPeriod: 14,
        atrStopMultiple: 2.5,
        targetR: 2.5,
        rsiPeriod: 14,
        rsiLongMin: 60,
        rsiShortMax: 40,
      },
      range: {
        enabled: true,
        maxAdx: 12,
        targetR: 2,
        minScore: 80,
      },
    },
    // ===== 1h tuning =====
    '1h': {
      swingLookbackDays: 0,
      pivotWindow: 2,
      swingMinDistancePct: 0.015,
      touchTolerance: 0.0006,
      touchCooldownMinutes: 60,
      confirmWithinCandles: 3,
      stopBuffer: 0.0005,
      regime: {
        adxPeriod: 14,
        adxThreshold: 30,
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        slowEmaSlopeLookback: 10,
      },
      trend: {
        breakoutLookback: 48,
        atrPeriod: 14,
        atrStopMultiple: 2.8,
        targetR: 3,
        rsiPeriod: 14,
        rsiLongMin: 65,
        rsiShortMax: 35,
      },
      range: {
        enabled: true,
        maxAdx: 16,
        targetR: 2,
        minScore: 85,
      },
    },
    // ===== 2h tuning =====
    '2h': {
      swingLookbackDays: 0,
      pivotWindow: 2,
      swingMinDistancePct: 0.015,
      touchTolerance: 0.0008,
      touchCooldownMinutes: 60,
      confirmWithinCandles: 3,
      stopBuffer: 0.0005,
      regime: {
        adxPeriod: 14,
        adxThreshold: 22,
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        slowEmaSlopeLookback: 10,
      },
      trend: {
        breakoutLookback: 64,
        atrPeriod: 14,
        atrStopMultiple: 3.1,
        targetR: 2.2,
        rsiPeriod: 14,
        rsiLongMin: 68,
        rsiShortMax: 32,
      },
      range: {
        enabled: true,
        maxAdx: 8,
        targetR: 1.4,
        minScore: 75,
      },
    },
    // ===== 4h tuning =====
    '4h': {
      swingLookbackDays: 0,
      pivotWindow: 2,
      swingMinDistancePct: 0.015,
      touchTolerance: 0.0015,
      touchCooldownMinutes: 60,
      confirmWithinCandles: 3,
      stopBuffer: 0.0005,
      regime: {
        adxPeriod: 14,
        adxThreshold: 18,
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        slowEmaSlopeLookback: 10,
      },
      trend: {
        breakoutLookback: 16,
        atrPeriod: 14,
        atrStopMultiple: 2.2,
        targetR: 1.4,
        rsiPeriod: 14,
        rsiLongMin: 62,
        rsiShortMax: 38,
      },
      range: {
        enabled: true,
        maxAdx: 12,
        targetR: 1.6,
        minScore: 85,
      },
    },
  } as Record<TradeInterval, IntervalTuning>,
  backtest: {
    feePerSide: 0.00035,
    slippagePerSide: 0.00015,
  },
  portfolio: {
    startingCapital: 1_000,
    leverage: 5,
    riskPerTrade: 0.02,
    maxPositionMargin: 0.25,
    maxTotalMargin: 1,
    cacheMs: 60_000,
  },
  trader: {
    enabled: traderEnabled,
    mode: traderMode as TraderMode,
    tradeInterval: '5m' as const,
    coins: traderCoins,
    coinSelection: traderCoinSelection,
    testnetRestUrl: 'https://api.hyperliquid-testnet.xyz',
    testnetWsUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
    maxOpenPositions: 10,
    dbPath: process.env.TRADER_DB_PATH ?? 'data/trader.db',
  },
  staleSocketSeconds: 90,
  apiPort: Number(process.env.API_PORT ?? 8787),
  pollMs: 5000,
  dbPath: process.env.DB_PATH ?? 'data/monitor.db',
  telegram: {
    botToken: process.env.TG_BOT_TOKEN ?? '',
    chatId: process.env.TG_CHAT_ID ?? '',
  },
  restUrl: 'https://api.hyperliquid.xyz/info',
  wsUrl: 'wss://api.hyperliquid.xyz/ws',
} as const;

export function tuningFor(interval: TradeInterval): IntervalTuning {
  return config.tuning[interval];
}

export function assertValidConfig() {
  validateConfig(config);
}

export function validateConfig(candidate: {
  coins: readonly string[];
  tradeInterval: string;
  tradeIntervals: readonly string[];
  regimeForTrade: Record<string, string | undefined>;
  candleInterval: string;
  regimeInterval: string | undefined;
  chartIntervals: readonly string[];
  backfillTarget: Record<string, number | undefined>;
}) {
  if (candidate.coins.length === 0) {
    throw new Error('No coins configured. Set the COINS env var.');
  }

  if (!candidate.tradeIntervals.includes(candidate.tradeInterval)) {
    throw new Error(`Trade interval ${candidate.tradeInterval} must be one of: ${candidate.tradeIntervals.join(', ')}.`);
  }

  const mappedRegimeInterval = candidate.regimeForTrade[candidate.tradeInterval];
  if (!mappedRegimeInterval) {
    throw new Error(`Trade interval ${candidate.tradeInterval} is missing a regime interval mapping.`);
  }

  if (candidate.candleInterval !== candidate.tradeInterval) {
    throw new Error(`Detection interval ${candidate.candleInterval} must match tradeInterval ${candidate.tradeInterval}.`);
  }
  if (candidate.regimeInterval !== mappedRegimeInterval) {
    throw new Error(`Regime interval ${candidate.regimeInterval} must match mapping ${candidate.tradeInterval} -> ${mappedRegimeInterval}.`);
  }

  if (!candidate.chartIntervals.includes(candidate.tradeInterval)) {
    throw new Error(`Trade interval ${candidate.tradeInterval} must be listed in chartIntervals.`);
  }
  if (!candidate.chartIntervals.includes(mappedRegimeInterval)) {
    throw new Error(`Regime interval ${mappedRegimeInterval} must be listed in chartIntervals.`);
  }

  for (const interval of candidate.tradeIntervals) {
    const regimeInterval = candidate.regimeForTrade[interval];
    if (!regimeInterval) {
      throw new Error(`Trade interval ${interval} is missing a regime interval mapping.`);
    }
    if (!candidate.chartIntervals.includes(interval)) {
      throw new Error(`Trade interval ${interval} must be listed in chartIntervals.`);
    }
    if (!candidate.chartIntervals.includes(regimeInterval)) {
      throw new Error(`Regime interval ${regimeInterval} must be listed in chartIntervals.`);
    }
  }

  for (const interval of candidate.chartIntervals) {
    const target = candidate.backfillTarget[interval];
    if (target === undefined || !Number.isInteger(target) || target < 1 || target > 5000) {
      throw new Error(`Invalid backfill target for ${interval}: ${target}`);
    }
  }
}

export function isKnownCoin(coin: string): boolean {
  const target = normalizeCoin(coin);
  return config.coins.includes(target);
}

// Keep the "xyz:" dex prefix lowercase but the asset symbol uppercase.
export function normalizeCoin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':')) {
    const [dex, ...rest] = trimmed.split(':');
    return `${dex.toLowerCase()}:${rest.join(':').toUpperCase()}`;
  }
  return trimmed.toUpperCase();
}
