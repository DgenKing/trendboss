# TrendBoss Security Audit — `paper-5min-only`

Date: 2026-06-15 · Scope: secret handling, order/execution safety, web/API exposure, supply chain, correctness sweep. No source code was modified.

## Summary verdict

TrendBoss is, on the whole, a tightly-scoped and defensively-written TESTNET-only bot. The headline concerns are clean: the wallet private key lives only in a gitignored `trader.secret.ts`, is never written to logs/health/API/error messages, and there is **no withdrawal or transfer capability anywhere in the codebase**. Mode is hard-locked to TESTNET (runtime throw + URL assertion), position caps are enforced, and SQL is fully parameterized. The single most important real-world risk is that the **`:8787` health/events API binds to all network interfaces (not localhost) with `Access-Control-Allow-Origin: *` and no authentication** — it is read-only so it cannot move funds, but on a shared/public host it exposes your live positions, equity, and event history to anyone. Tests (43) pass and `tsc --noEmit` is clean.

---

## High

### H1 — API binds to all interfaces, no auth, wildcard CORS
`packages/monitor/api.ts:8-44, 85-95`
- **What:** `Bun.serve({ port: config.apiPort, fetch })` does not set `hostname`. Bun defaults to binding `0.0.0.0` (all interfaces), so the log line "listening on http://localhost:8787" is misleading. Every response sets `Access-Control-Allow-Origin: *`. No auth on any route.
- **Why it matters:** On any host with a routable/LAN IP, `/health` and `/events` are reachable by third parties, leaking open positions, sizes, stops/targets, equity, used margin, last errors, and the full append-only event log. The wildcard CORS additionally lets any website the operator visits read these endpoints from their browser. It is GET-only and read-only, so no trading actions are possible — this is information disclosure, not fund movement. (OWASP A01: Broken Access Control, A05: Security Misconfiguration.)
- **Fix:** Bind to loopback explicitly: `Bun.serve({ port: config.apiPort, hostname: '127.0.0.1', fetch })`. Drop `Access-Control-Allow-Origin: *` (or restrict to the panel origin `http://localhost:3000`). If remote access is genuinely needed, put it behind an authenticated reverse proxy.

---

## Medium

### M1 — `/events` path read is fine, but the API has no rate limiting and reads the full log on every request
`packages/monitor/api.ts:66-83`
- **What:** Each `/events` request reads and parses the entire `logs/events.TESTNET.jsonl` file, then slices. Combined with H1 (public bind), an unauthenticated client can force repeated full-file reads/parses.
- **Why it matters:** Cheap DoS / CPU + IO amplification on the trading host, which shares the box with the live trader loop. Low severity if H1 is fixed (loopback only).
- **Fix:** Fixing H1 largely neutralizes this. Optionally tail the file from the end or cap request frequency.

### M2 — Orphan-entry close uses the requested size, not the actual filled size
`packages/trader/testnet.ts:162-171, 397-435`
- **What:** When protective triggers fail to rest, `closeFilledEntryIfUnprotected` is called with `size: fill.totalSz` (the filled qty) — that part is correct. However the unprotected-close path issues a single IOC `reduce_only` order at `protectivePrice` and, if `acceptedFill` is null, only logs an error and returns. There is no retry and no verification via `findExchangePosition` that the position actually reached flat.
- **Why it matters:** A genuinely unprotected, still-open position could be left open after a failed orphan close, with the operator believing the failure path handled it (it logs but does not surface to health). Financial-loss exposure if the market moves before the next reconcile cycle catches it. Note: `reconcileLiveState` will eventually mirror the orphan and is the safety net, so this is a window, not a permanent gap.
- **Fix:** After the orphan-close attempt, call `findExchangePosition` and loop/retry (bounded) until flat, and record a `lastError` so it appears in `/health`.

### M3 — Reconcile-flatten relies on coin-name matching that mixes local and exchange position sources
`packages/trader/testnet.ts:269-294`
- **What:** The "exchange is flat → close local" loop (`for (const local of localPositions)`) deletes/closes any local position whose coin is not in `exchangeByCoin`. `exchangeByCoin` is keyed by `plainCoin(position.coin)` and only includes positions with `|szi| > 0`. This is correct as written, but it trusts a single clearinghouse snapshot: a transient empty/partial `assetPositions` response (API hiccup) would make the bot conclude the exchange is flat and book closed trades against possibly-still-open positions.
- **Why it matters:** A bad/empty API response during reconcile could cause spurious "reconciled flat" closures and wrong PnL reporting. The exchange position itself is untouched (no order is sent in this branch — it only updates local books), so this is a *reporting* correctness risk, not a fund-movement risk.
- **Fix:** Guard the flatten branch: skip booking closed trades if the clearinghouse response looks degenerate (e.g. `state.assetPositions` empty AND `marginSummary.accountValue` unchanged/zero AND prior cycle had open positions), or require two consecutive flat observations before closing local books.

---

## Low

### L1 — Misleading "localhost" log message
`packages/monitor/api.ts:42` — The startup banner says `http://localhost:8787` while the socket is actually bound to all interfaces. Misleads the operator into thinking it is loopback-only. Fixed by binding to `127.0.0.1` (see H1).

### L2 — Order/trigger raw responses are logged verbatim to console/log files
`packages/trader/testnet.ts:134, 141-143, 536, 540`; `fillFromOrder` stores `JSON.stringify(raw).slice(0,2000)` (`testnet.ts:766`)
- The full SDK order responses are logged. These contain order ids, sizes, prices — operationally sensitive but **not** the private key (the SDK never echoes the signing key in responses). Verified no key material is in these payloads. Keep an eye on it if the SDK changes; consider trimming in production.

### L3 — `.claude/settings.local.json` contains a real wallet address and key-generation commands
`.claude/settings.local.json:23-41,64` — Pre-approved bash commands embed a testnet account address (`0x9350...1865`) and `Wallet.createRandom()` snippets. No private key is stored, and the address alone is public-by-design on-chain. Informational; just be aware this file is in the repo tree.

---

## Informational

- **I1 — Example secret file is the only tracked secret artifact.** `git ls-files | grep secret` returns only `trader.secret.example.ts` (placeholder `0x...`). `git check-ignore trader.secret.ts` confirms the real file is ignored. `.gitignore` correctly lists `trader.secret.ts`, `.env`, `logs/`, `*.log`, `data/*.db`. Good.
- **I2 — Lockfile present.** `bun.lock` (53 KB) is committed; single runtime dependency `hyperliquid ^1.7.7`. Small, auditable surface. The `^` range allows minor/patch drift — consider pinning exactly for a fund-signing app, and periodically run a dependency audit on the `hyperliquid` SDK since it holds the signing key in memory.
- **I3 — `start.sh` uses `set -u` but not `set -e`** (`scripts/start.sh:6`). A failed component start won't abort the launcher. The other scripts use `set -euo pipefail`. Minor operational robustness only; no security impact. No command-injection or path-traversal found in any `scripts/*.sh` (no untrusted input is interpolated).

---

## Things that are correct / good

- **No withdrawal/transfer/usdSend/spotSend/usdClassTransfer/subAccountTransfer anywhere** in `packages/trader`, `packages/monitor`, or `config.ts`. The bot physically cannot move funds off the account.
- **Private key never leaves `trader.secret.ts`.** Loaded lazily via dynamic import (`testnet.ts:438-448`); never logged, never placed in `HealthPayload` (only the boolean `secretPresent`), never returned by the API, never in error messages (the load-failure error includes only the generic SDK message, not the key).
- **TESTNET hard-lock, defense in depth:** `index.ts:344-345` throws if mode ≠ TESTNET; `testnet.ts:89-91` refuses to start if the SDK base URL is not a `hyperliquid-testnet` host; config only ever points at testnet URLs for the trader. There is no mainnet URL referenced in `packages/trader/*.ts`.
- **Position-size and exposure caps enforced:** `maxOpenPositions` (`index.ts:171`), and per-trade/total margin caps via `calculateLiveAllocation` → `maxPositionMargin`/`maxTotalMargin`/`riskPerTrade` (`sizing.ts`, `config.ts:278-285`). Rounded-zero sizes are rejected (`testnet.ts:100-102`); invalid prices throw (`formatPrice`).
- **Order safety:** entries are IOC limit with `protectivePrice` slippage guard; stop/target are `reduce_only` triggers grouped `normalTpsl`; if triggers don't rest the code cancels them and closes the filled entry (`testnet.ts:152-177`). Close orders are `reduce_only` and re-verify the exchange is flat (`testnet.ts:228-231`).
- **SQL is fully parameterized** in both `packages/monitor/store.ts` and `packages/trader/store.ts` (prepared statements with `?` placeholders; no string concatenation of user/dynamic values). No SQL injection surface.
- **API is GET-only:** non-GET returns 405; only `/health`, `/api/status`, `/events`, `/api/events`, `/` are routed. No action endpoints exist — the panel is read-only as intended.
- **`packages/core` / `FIVE_MIN_TUNING`:** reviewed as a frozen parity contract; no security bugs found, nothing flagged for change.

## `bun run check` result

PASS. `bun test` → **43 pass / 0 fail** (228 assertions, 2 files). `bunx tsc --noEmit` → **exit 0** (clean typecheck).
