// In-memory metrics collector for deep observability.
// Ring buffer (last 1000 requests) + computed percentiles.
// For historical aggregates, use the usage DB; this is for real-time.

const MAX_REQUESTS = 1000;
const requests = [];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function recordRequestMetrics({
  provider,
  model,
  ttftMs = 0,
  totalMs = 0,
  promptTokens = 0,
  completionTokens = 0,
  status = "ok",
  errorType = null,
  breakerState = null,
  savers = [],
  cached = false,
} = {}) {
  requests.push({
    ts: Date.now(),
    provider: provider || "unknown",
    model: model || "unknown",
    ttftMs,
    totalMs,
    promptTokens,
    completionTokens,
    status,
    errorType,
    breakerState,
    savers: Array.isArray(savers) ? savers : [],
    cached: !!cached,
  });
  if (requests.length > MAX_REQUESTS) {
    requests.splice(0, requests.length - MAX_REQUESTS);
  }
}

export function getMetricsSummary() {
  const now = Date.now();
  const windows = {
    "5m": 5 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };
  const out = {};

  for (const [label, ms] of Object.entries(windows)) {
    const slice = requests.filter((r) => now - r.ts < ms);
    const ttfts = slice.map((r) => r.ttftMs).filter((v) => v > 0).sort((a, b) => a - b);
    const totals = slice.map((r) => r.totalMs).filter((v) => v > 0).sort((a, b) => a - b);
    // Mirror breaker: client aborts are not provider failures
    const errors = slice.filter((r) => r.status !== "ok" && r.errorType !== "AbortError").length;

    const byProvider = {};
    for (const r of slice) {
      if (!byProvider[r.provider]) {
        byProvider[r.provider] = { count: 0, errors: 0, latencies: [], tokens: 0 };
      }
      const p = byProvider[r.provider];
      p.count++;
      // Mirror breaker: client aborts are not provider failures
      if (r.status !== "ok" && r.errorType !== "AbortError") p.errors++;
      if (r.totalMs > 0) p.latencies.push(r.totalMs);
      p.tokens += r.promptTokens + r.completionTokens;
    }
    for (const p of Object.values(byProvider)) {
      p.latencies.sort((a, b) => a - b);
      p.p50 = percentile(p.latencies, 50);
      p.p95 = percentile(p.latencies, 95);
      delete p.latencies;
    }

    // Saver usage + cache hit rate
    const saverCounts = {};
    let cacheHits = 0;
    for (const r of slice) {
      for (const s of r.savers || []) {
        const name = s.split(":")[0];
        saverCounts[name] = (saverCounts[name] || 0) + 1;
      }
      if (r.cached) cacheHits++;
    }

    out[label] = {
      count: slice.length,
      errors,
      errorRate: slice.length ? errors / slice.length : 0,
      ttft: { p50: percentile(ttfts, 50), p95: percentile(ttfts, 95), p99: percentile(ttfts, 99) },
      total: { p50: percentile(totals, 50), p95: percentile(totals, 95), p99: percentile(totals, 99) },
      tokens: slice.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0),
      byProvider,
      savers: saverCounts,
      cacheHitRate: slice.length ? cacheHits / slice.length : 0,
    };
  }

  return {
    windows: out,
    bufferSize: requests.length,
  };
}

export function getRecentRequests(limit = 50) {
  return requests.slice(-limit).reverse().map((r) => ({
    ts: r.ts,
    provider: r.provider,
    model: r.model,
    ttftMs: r.ttftMs,
    totalMs: r.totalMs,
    tokens: r.promptTokens + r.completionTokens,
    status: r.status,
    errorType: r.errorType,
  }));
}

// Test-only
export function _clearMetricsForTests() {
  requests.length = 0;
}
