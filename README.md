# Suneo

AI gateway fork of [decolua/9router](https://github.com/decolua/9router) (v0.5.95) with security hardening, dual circuit breaker, observability, and smart routing.

## What's implemented

### Security hardening (Part A)
- **PXPIPE bypass fixed** — honors `x-9router-token-saver` header
- **Request logger** — masks sensitive headers
- **CLI** — masks API keys in terminal output
- **Endpoint UI** — always masks displayed keys; per-key Copy button
- **MITM** — pins `DATA_DIR` in privileged child process environment

### Dual circuit breaker
Two-level failure isolation: **per-provider** and **per-connection**, in-memory state.
- **Failure:** network errors, 5xx (provider); persistent 401, explicit-auth 403 (connection)
- **Ignored:** 429, content-filter, client aborts, stream lifecycle errors, ambiguous
- **Multi-account guard:** ≥2 distinct failing accounts trip it (sole account trips alone)
- **HALF_OPEN probe rotation** through untried accounts
- **Combo:** provider OPEN → 503 sentinel → next model (no throw)
- **Kill-switch:** `CIRCUIT_BREAKER_ENABLED=false`

### Observability
- **`/dashboard/observe`** — real-time latency p50/p95/p99, error rates, per-provider breakdown, saver usage, cache hit rate (5s auto-refresh)
- **`/dashboard/breakers`** — breaker states with manual reset
- **`GET /api/metrics`** — 5m/1h/24h windows + recent requests

### Smart routing (opt-in)
- **Health-based:** 60% error rate + 25% latency + 15% cost
- **Response cache:** exact-match, non-streaming, 3h TTL — hit = zero upstream tokens
- Set combo strategy to `"smart"`

## Tests
100+ passing (`tests/unit/`): breaker, combo fallback, dashboard APIs, metrics, smart router, response cache.

## Upstream note
Provider registry contains placeholder OAuth credentials from upstream (redacted). Configure your own credentials per provider.
