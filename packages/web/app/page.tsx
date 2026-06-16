'use client';

import { useEffect, useMemo, useState } from 'react';
import { getEvents, getHealth, type EventRecord, type HealthPayload, type LivePosition } from '../lib/api';

export default function Page() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [nextHealth, nextEvents] = await Promise.all([getHealth(), getEvents()]);
        if (!active) return;
        setHealth(nextHealth);
        setEvents(nextEvents);
        setError(null);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'TESTNET API unavailable');
      }
    }
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const positions = useMemo(
    () => health?.coins.flatMap((coin) => coin.position ? [coin.position] : []) ?? [],
    [health],
  );
  const closed = useMemo(() => events.filter((event) => event.type === 'CLOSE').reverse(), [events]);
  const visibleEvents = useMemo(
    () => events.filter((event) => event.type !== 'HEARTBEAT').reverse().slice(0, 80),
    [events],
  );
  const latestError = useMemo(() => [...events].reverse().find((event) => event.type === 'ERROR') ?? null, [events]);

  return (
    <main className="min-h-screen bg-[#090b0e] text-[#f4f5f7]">
      <header className="border-b border-white/10 bg-[#0d1015]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-300">Hyperliquid TESTNET</p>
            <h1 className="mt-1 text-2xl font-semibold">Hermes Trades</h1>
            <p className="mt-1 text-sm text-white/50">$10 max margin · one coin at a time · stop + TP required</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusDot ok={Boolean(health?.ok) && !error} />
            <div>
              <p className="text-sm font-semibold">{error ? 'API unavailable' : health?.ok ? 'Healthy' : 'Attention required'}</p>
              <p className="text-xs text-white/45">Updated {formatTime(health?.updatedAt ?? null)}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] space-y-5 px-5 py-5">
        {error ? <Alert text={error} /> : null}
        {health?.lastError ? <Alert text={health.lastError} /> : null}
        {!health?.lastError && latestError ? <Alert text={`Latest trader error: ${latestError.reason ?? latestError.error ?? 'unknown'}`} /> : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Metric label="Web" value="Running" good />
          <Metric label="API" value={error ? 'Down' : 'Running'} good={!error} />
          <Metric label="Mode" value={health?.mode ?? '--'} good={health?.mode === 'TESTNET'} />
          <Metric label="Trader" value={health?.traderRunning ? 'Running' : 'Down'} good={health?.traderRunning} />
          <Metric label="Feed" value={health?.feedSocketStatus ?? '--'} good={health?.feedSocketStatus !== 'STALE'} />
          <Metric label="Heartbeat" value={health?.heartbeatAgeSec == null ? '--' : `${health.heartbeatAgeSec}s`} good={health?.ok} />
          <Metric label="Equity" value={formatUsd(health?.equity)} />
          <Metric label="Used margin" value={formatUsd(health?.usedMargin)} />
        </section>

        <Panel title="10-Coin Live State">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr className="border-b border-white/10">
                  <Th>Coin</Th><Th>Price</Th><Th>Last closed 5m</Th><Th>Position</Th><Th>Last signal</Th><Th>Last order attempt</Th>
                </tr>
              </thead>
              <tbody>
                {(health?.coins ?? []).map((coin) => (
                  <tr key={coin.coin} className="border-b border-white/5 align-top last:border-0">
                    <Td><span className="font-semibold text-sky-200">{coin.coin}</span></Td>
                    <Td>{formatPrice(coin.price)}</Td>
                    <Td>{formatTime(coin.lastClosed5mCandle)}</Td>
                    <Td>{coin.position ? <PositionBrief position={coin.position} /> : <Muted>Flat</Muted>}</Td>
                    <Td>{coin.lastSignal ? (
                      <Stack lines={[
                        `${coin.lastSignal.direction} ${labelStrategy(coin.lastSignal.strategy)} · score ${coin.lastSignal.score}`,
                        formatTime(coin.lastSignal.time),
                      ]} />
                    ) : <Muted>None</Muted>}</Td>
                    <Td>{coin.lastOrderAttempt ? (
                      <Stack lines={[
                        `${coin.lastOrderAttempt.status} · ${coin.lastOrderAttempt.reason}`,
                        formatTime(coin.lastOrderAttempt.time),
                      ]} />
                    ) : <Muted>None</Muted>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <section className="grid gap-5 xl:grid-cols-2">
          <Panel title={`Hermes Trades (${positions.length ? positions.length : 'None'})`}>
            {positions.length ? positions.map((position) => <PositionCard key={position.coin} position={position} />) : <Empty text="Hermes Trades: None" />}
          </Panel>
          <Panel title={`Closed TESTNET Trades (${closed.length})`}>
            <div className="space-y-2">
              {closed.slice(0, 20).map((event) => (
                <div key={event.eventId} className="grid grid-cols-[70px_1fr_auto] gap-3 border-b border-white/5 py-3 text-sm">
                  <strong>{event.symbol}</strong>
                  <span className="text-white/65">{event.direction} {labelStrategy(event.strategy)} · {event.reason}</span>
                  <span className={(event.pnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatUsd(event.pnl)}</span>
                </div>
              ))}
              {!closed.length ? <Empty text="No CLOSE events recorded" /> : null}
            </div>
          </Panel>
        </section>

        <Panel title="TESTNET Event Log">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr className="border-b border-white/10"><Th>Time</Th><Th>Type</Th><Th>Coin</Th><Th>Status</Th><Th>Details</Th><Th>Trade ID</Th></tr>
              </thead>
              <tbody>
                {visibleEvents.map((event) => (
                  <tr key={event.eventId} className="border-b border-white/5 last:border-0">
                    <Td>{formatTime(event.ts)}</Td><Td><EventBadge type={event.type} /></Td><Td>{event.symbol ?? '--'}</Td>
                    <Td>{event.status}</Td><Td>{event.reason ?? '--'}</Td><Td><code className="text-xs text-white/35">{event.tradeId.slice(0, 12)}</code></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleEvents.length ? <Empty text="No TESTNET events recorded" /> : null}
          </div>
        </Panel>
      </div>
    </main>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`h-3 w-3 rounded-full ${ok ? 'bg-emerald-400 shadow-[0_0_18px_#34d399]' : 'bg-rose-400 shadow-[0_0_18px_#fb7185]'}`} />;
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="rounded-lg border border-white/10 bg-[#11151b] p-4"><p className="text-xs uppercase tracking-wider text-white/40">{label}</p><p className={`mt-2 text-lg font-semibold ${good === false ? 'text-rose-300' : good ? 'text-emerald-300' : ''}`}>{value}</p></div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border border-white/10 bg-[#11151b]"><h2 className="border-b border-white/10 px-4 py-3 text-sm font-semibold uppercase tracking-wider text-white/60">{title}</h2><div className="p-4">{children}</div></section>;
}

function PositionBrief({ position }: { position: LivePosition }) {
  return <Stack lines={[`${position.direction} · ${formatPrice(position.entry)} → ${formatPrice(position.currentPrice)}`, `PnL ${formatUsd(position.unrealizedPnl)} · margin ${formatUsd(position.margin)}`]} />;
}

function PositionCard({ position }: { position: LivePosition }) {
  return <div className="mb-3 rounded-md border border-white/10 bg-black/20 p-4 last:mb-0"><div className="flex items-center justify-between"><strong>{position.coin} {position.direction}</strong><span className={position.unrealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatUsd(position.unrealizedPnl)}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-sm text-white/60 sm:grid-cols-4"><span>Entry {formatPrice(position.entry)}</span><span>Stop {formatPrice(position.stop)}</span><span>Target {formatPrice(position.target)}</span><span>Size {position.quantity}</span><span>Margin {formatUsd(position.margin)}</span><span>Fees {formatUsd(position.fees)}</span><span>Strategy {labelStrategy(position.strategy)}</span><span>Opened {formatTime(position.entryTime)}</span></div></div>;
}

function EventBadge({ type }: { type: EventRecord['type'] }) {
  const color = type === 'ERROR' ? 'text-rose-300' : type === 'OPEN' ? 'text-emerald-300' : type === 'CLOSE' ? 'text-amber-300' : 'text-sky-200';
  return <span className={color}>{type}</span>;
}

function Stack({ lines }: { lines: string[] }) { return <span className="block"><span className="block">{lines[0]}</span><span className="mt-1 block text-xs text-white/40">{lines[1]}</span></span>; }
function Muted({ children }: { children: React.ReactNode }) { return <span className="text-white/35">{children}</span>; }
function Empty({ text }: { text: string }) { return <p className="py-6 text-center text-sm text-white/35">{text}</p>; }
function Alert({ text }: { text: string }) { return <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{text}</div>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-3 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-3">{children}</td>; }

function formatTime(value: number | null) { return value ? new Date(value).toLocaleString() : '--'; }
function formatUsd(value: number | null | undefined) { return typeof value === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : '--'; }
function formatPrice(value: number | null | undefined) { return typeof value === 'number' ? value.toLocaleString('en-US', { maximumSignificantDigits: 8 }) : '--'; }
function labelStrategy(value: string | null) { return value?.replaceAll('_', ' ') ?? '--'; }
