// Smart router: rank combo models by observed provider health + cost.
// Uses metrics.js data (latency p50, error rate) + circuit breaker state + pricing.
// Opt-in via strategy="smart"; falls back to input order when no data.

import { getMetricsSummary } from "./metrics.js";
import { isProviderBreakerOpen } from "./circuitBreaker.js";
import { getPricingForModel } from "../providers/pricing.js";

// Score: lower is better. Weighted combination.
// - Error rate (0-1): weighted heaviest — reliability first
// - Latency p50 (ms): normalized to 0-1 via 10000ms cap
// - Cost ($/1M tokens): normalized to 0-1 via $30 cap (most expensive models)
// - Breaker OPEN: infinite (excluded)
export function scoreProvider(provider, metricsWindow, model = null) {
  const p = metricsWindow?.byProvider?.[provider];
  if (!p || p.count === 0) return null; // no data

  const latencyNorm = Math.min(p.p50 / 10000, 1);
  const errorRate = p.count > 0 ? p.errors / p.count : 0;

  // Cost: $/1M blended (input+output)/2, normalized via $30 cap
  let costNorm = 0.5; // neutral if no pricing data
  if (model) {
    try {
      const pricing = getPricingForModel(provider, model);
      if (pricing && (pricing.input > 0 || pricing.output > 0)) {
        const blended = (pricing.input + pricing.output) / 2;
        costNorm = Math.min(blended / 30, 1);
      } else if (pricing && pricing.input === 0 && pricing.output === 0) {
        costNorm = 0; // free
      }
    } catch {}
  }

  // 60% error rate, 25% latency, 15% cost. Reliability first, then speed, then price.
  return errorRate * 0.6 + latencyNorm * 0.25 + costNorm * 0.15;
}

// Rank models by provider score. Models without data keep relative order at the end.
// Each model is expected to have a `provider` field or be a "provider/model" string.
export function rankModelsByHealth(models) {
  if (!models || models.length <= 1) return models;

  const summary = getMetricsSummary();
  const window = summary.windows["1h"]; // 1h gives stable signal

  const scored = models.map((m, idx) => {
    const provider = typeof m === "string" ? m.split("/")[0] : m.provider;
    const modelName = typeof m === "string" ? m.split("/").slice(1).join("/") : m.model;
    // Breaker OPEN = skip entirely (will be tried last via fallback)
    if (provider && isProviderBreakerOpen(provider)) {
      return { model: m, idx, score: Infinity, provider };
    }
    const score = provider ? scoreProvider(provider, window, modelName) : null;
    return { model: m, idx, score: score ?? 0.5, provider }; // no data = neutral 0.5
  });

  // Stable sort: by score, then original index
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.idx - b.idx;
  });

  return scored.map((s) => s.model);
}

// Test-only: score with injected metrics (no dependency on live state)
export function scoreProviderWithData(provider, byProvider) {
  return scoreProvider(provider, { byProvider });
}
