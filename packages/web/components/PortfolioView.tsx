'use client';

import dynamic from 'next/dynamic';
import type {
  PortfolioAttribution,
  PortfolioDecision,
  PortfolioPosition,
  PortfolioResult,
} from '../../core/portfolio';
import { displayCoin } from '../lib/api';

const PortfolioChart = dynamic(() => import('./PortfolioChart'), { ssr: false });

export default function PortfolioView({
  result,
  loading,
  error,
  theme,
  tradeInterval,
}: {
  result: PortfolioResult | null;
  loading: boolean;
  error: string | null;
  theme: string;
  tradeInterval: string;
}) {
  if (error) {
    return <div className="border border-line bg-surface px-5 py-8 text-negative">{error}</div>;
  }
  if (!result) {
    return <div className="border border-line bg-surface px-5 py-8 text-muted">{loading ? 'Computing shared portfolio...' : 'Portfolio unavailable'}</div>;
  }

  const latest = result.timeline.at(-1);
  const decisions = latestDecisions(
    result.decisions,
    result.activePositions,
    result.commonEndTime,
    result.tradeInterval ?? tradeInterval,
  );

  return (
    <section className="border border-line bg-surface">
      <header className="flex flex-wrap items-end justify-between gap-5 border-b-2 border-ink px-5 py-4">
        <div>
          <div className="text-xs uppercase text-muted">Portfolio equity</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <h1 className="text-3xl font-semibold">{formatUsd(result.summary.finalEquity)}</h1>
            <span className={result.summary.totalReturnPct >= 0 ? 'text-positive' : 'text-negative'}>
              {formatPercent(result.summary.totalReturnPct)}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted">
            Shared capital from {formatDate(result.commonStartTime)} to {formatDate(result.commonEndTime)}
            {' '}· {(result.tradeInterval ?? tradeInterval)} · {historyDepth(result.tradeInterval ?? tradeInterval)} · historical simulation only
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Headline label="Start" value={formatUsd(result.summary.startingCapital)} />
          <Headline label="Max DD" value={formatPercent(-result.summary.maxDrawdownPct)} tone="negative" />
          <Headline label="Used margin" value={formatUnsignedPercent(latest?.usedMarginPct ?? 0)} />
          <Headline label="Gross exposure" value={formatUnsignedPercent(latest?.grossExposurePct ?? 0)} />
        </div>
      </header>

      <div className="p-4">
        <PortfolioChart points={result.timeline} theme={theme} />
      </div>

      <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,.5fr)]">
        <div className="min-w-0 border border-line bg-surface2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="font-semibold">Allocation board</h2>
            <span className="text-xs text-muted">2% equity risk · highest score first</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Market</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Margin</th>
                  <th className="px-3 py-2 font-medium">Notional</th>
                  <th className="px-3 py-2 font-medium">Risk</th>
                  <th className="px-3 py-2 font-medium">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {result.activePositions.map((position) => <PositionRow key={position.coin} position={position} />)}
                {decisions.map((decision) => <DecisionRow key={`${decision.time}-${decision.coin}`} decision={decision} />)}
                {result.activePositions.length === 0 && decisions.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-muted">No current allocation decisions.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border border-line bg-surface2 p-4">
          <h2 className="font-semibold">Portfolio risk</h2>
          <div className="mt-4 h-2 bg-line">
            <div className="h-full bg-positive" style={{ width: `${Math.min(100, (latest?.usedMarginPct ?? 0) * 100)}%` }} />
          </div>
          <div className="mt-2 text-xs text-muted">{formatUnsignedPercent(latest?.usedMarginPct ?? 0)} of margin allocated</div>
          <div className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <RiskItem label="Active positions" value={String(result.summary.activePositions)} />
            <RiskItem
              label="Risk at stops"
              value={formatUnsignedPercent(sum(result.activePositions.map((position) => position.riskAtStop)) / result.summary.finalEquity)}
            />
            <RiskItem label="Available margin" value={formatUsd(Math.max(0, result.summary.finalEquity - (latest?.usedMargin ?? 0)))} />
            <RiskItem label="Liquidations" value={String(result.summary.liquidations)} />
          </div>
        </div>
      </div>

      <div className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-4">
        <FooterMetric label="Closed trades" value={String(result.summary.closedTrades)} />
        <FooterMetric label="Rejected signals" value={String(result.summary.rejectedSignals)} />
        <FooterMetric label="Fees paid" value={formatUsd(result.summary.feesPaid)} />
        <FooterMetric label="Portfolio PF" value={formatFactor(result.summary.profitFactor)} />
      </div>

      <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
        <Attribution title="P&L by token" rows={result.bySymbol} />
        <Attribution title="P&L by strategy" rows={result.byStrategy} />
      </div>
    </section>
  );
}

function PositionRow({ position }: { position: PortfolioPosition }) {
  return (
    <tr className="border-t border-line">
      <td className="whitespace-nowrap px-3 py-2 font-semibold">{displayCoin(position.coin)} {position.direction}</td>
      <td className="px-3 py-2 font-semibold text-positive">OPEN</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUnsignedPercent(position.allocationPct)} · {formatUsd(position.margin)}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUsd(position.notional)}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUsd(position.riskAtStop)}</td>
      <td className={position.unrealizedPnl >= 0 ? 'px-3 py-2 text-positive' : 'px-3 py-2 text-negative'}>{formatSignedUsd(position.unrealizedPnl)}</td>
    </tr>
  );
}

function DecisionRow({ decision }: { decision: PortfolioDecision }) {
  const statusTone = decision.status === 'REJECTED' ? 'text-negative' : decision.status === 'PARTIAL' ? 'text-warning' : 'text-positive';
  return (
    <tr className="border-t border-line">
      <td className="whitespace-nowrap px-3 py-2 font-semibold">{displayCoin(decision.coin)} {decision.direction}</td>
      <td className={`px-3 py-2 font-semibold ${statusTone}`}>{decision.status}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUnsignedPercent(decision.allocationPct)} · {formatUsd(decision.margin)}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUsd(decision.notional)}</td>
      <td className="whitespace-nowrap px-3 py-2">{formatUsd(decision.riskAtStop)}</td>
      <td className="px-3 py-2 text-muted">{decision.reason.replace('_', ' ')}</td>
    </tr>
  );
}

function Attribution({ title, rows }: { title: string; rows: PortfolioAttribution[] }) {
  return (
    <div className="border border-line bg-surface2">
      <h2 className="border-b border-line px-3 py-2 font-semibold">{title}</h2>
      {rows.slice(0, 8).map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm">
          <span>{displayCoin(row.label)}</span>
          <span className={row.pnl >= 0 ? 'text-positive' : 'text-negative'}>{row.trades} trades · {formatSignedUsd(row.pnl)}</span>
        </div>
      ))}
    </div>
  );
}

function Headline({ label, value, tone }: { label: string; value: string; tone?: 'negative' }) {
  return <div><div className="text-xs uppercase text-muted">{label}</div><div className={tone === 'negative' ? 'font-semibold text-negative' : 'font-semibold'}>{value}</div></div>;
}

function RiskItem({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs uppercase text-muted">{label}</div><div className="mt-1 font-semibold">{value}</div></div>;
}

function FooterMetric({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm sm:border-r"><span className="font-medium">{label}</span><span>{value}</span></div>;
}

function latestDecisions(
  decisions: PortfolioDecision[],
  active: PortfolioPosition[],
  commonEndTime: number | null,
  tradeInterval: string,
) {
  const activeCoins = new Set(active.map((position) => position.coin));
  const recentCutoff = (commonEndTime ?? 0) - intervalToMs(tradeInterval);
  return [...decisions]
    .filter((decision) => !activeCoins.has(decision.coin) && decision.time >= recentCutoff)
    .sort((a, b) => b.time - a.time || b.score - a.score)
    .slice(0, 8);
}

function historyDepth(interval: string) {
  return ({
    '15m': '~52 days',
    '1h': '~208 days',
    '2h': '~417 days',
    '4h': '~833 days',
  } as Record<string, string>)[interval] ?? 'available history';
}

function intervalToMs(interval: string) {
  const match = /^(\d+)(m|h|d)$/.exec(interval);
  if (!match) return 15 * 60 * 1000;
  const value = Number(match[1]);
  if (match[2] === 'm') return value * 60 * 1000;
  if (match[2] === 'h') return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

function formatUsd(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function formatSignedUsd(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatUsd(value)}`;
}

function formatPercent(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatUnsignedPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatFactor(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : 'INF';
}

function formatDate(timestamp: number | null) {
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : 'Waiting';
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
