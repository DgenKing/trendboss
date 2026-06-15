import { existsSync, readFileSync } from 'node:fs';
import { config } from '../../config';
import { readHealthSnapshot, refreshHealthSnapshot } from '../trader/health';

const EVENT_LOG_PATH = 'logs/events.TESTNET.jsonl';

export function startApi() {
  const server = Bun.serve({
    port: config.apiPort,
    fetch(request) {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return json({});
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

      if (url.pathname === '/health' || url.pathname === '/api/status') {
        return json(refreshHealthSnapshot(readHealthSnapshot()));
      }

      if (url.pathname === '/events' || url.pathname === '/api/events') {
        const limit = clamp(Number(url.searchParams.get('limit') ?? 200), 1, 1000);
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0));
        return json(readEvents(limit, after));
      }

      if (url.pathname === '/') {
        return html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TrendBoss TESTNET API</title></head>
  <body style="font-family:system-ui;background:#0b0d10;color:#f4f5f7;padding:32px">
    <h1>TrendBoss TESTNET 5m API</h1>
    <p><a style="color:#7dd3fc" href="/health">/health</a></p>
    <p><a style="color:#7dd3fc" href="/events">/events</a></p>
  </body>
</html>`);
      }

      return json({ error: 'Not found' }, 404);
    },
  });

  console.log(`[api] TESTNET health API listening on http://localhost:${server.port}`);
  return server;
}

// Kept as a small shared utility for the retained on-demand backtest engine.
export type IntervalCacheEntry<T> = { computedAt: number; result: T };

export function createIntervalResultCache<T>() {
  return new Map<string, IntervalCacheEntry<T>>();
}

export function getCachedIntervalResult<T>(
  cache: Map<string, IntervalCacheEntry<T>>,
  key: string,
  cacheMs: number,
  build: () => T,
): T {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.computedAt < cacheMs) return cached.result;
  const result = build();
  cache.set(key, { computedAt: Date.now(), result });
  return result;
}

function readEvents(limit: number, after: number): unknown[] {
  if (!existsSync(EVENT_LOG_PATH)) return [];
  try {
    const lines = readFileSync(EVENT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const events: unknown[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { eventId?: number };
        if ((event.eventId ?? 0) > after) events.push(event);
      } catch {
        // Ignore a partially-written final line; the append-only log remains the source of truth.
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function html(payload: string) {
  return new Response(payload, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
