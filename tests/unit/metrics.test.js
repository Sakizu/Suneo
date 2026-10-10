import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRequestMetrics,
  getMetricsSummary,
  getRecentRequests,
  _clearMetricsForTests,
} from "open-sse/utils/metrics.js";

describe("metrics collector", () => {
  beforeEach(() => _clearMetricsForTests());

  it("records and summarizes requests", () => {
    recordRequestMetrics({ provider: "openai", model: "gpt-4", totalMs: 500, status: "ok", promptTokens: 100, completionTokens: 50 });
    recordRequestMetrics({ provider: "openai", model: "gpt-4", totalMs: 1500, status: "error", errorType: "http_500" });
    const s = getMetricsSummary();
    expect(s.windows["5m"].count).toBe(2);
    expect(s.windows["5m"].errors).toBe(1);
    expect(s.windows["5m"].errorRate).toBe(0.5);
    expect(s.windows["5m"].tokens).toBe(150);
  });

  it("computes percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordRequestMetrics({ provider: "x", model: "y", totalMs: i * 20, status: "ok" });
    }
    const s = getMetricsSummary();
    expect(s.windows["5m"].total.p50).toBe(1000);
    expect(s.windows["5m"].total.p95).toBe(1900);
    expect(s.windows["5m"].total.p99).toBe(1980);
  });

  it("groups by provider", () => {
    recordRequestMetrics({ provider: "a", model: "m", ttftMs: 100, status: "ok" });
    recordRequestMetrics({ provider: "b", model: "m", ttftMs: 200, status: "ok" });
    const s = getMetricsSummary();
    expect(Object.keys(s.windows["5m"].byProvider)).toContain("a");
    expect(Object.keys(s.windows["5m"].byProvider)).toContain("b");
  });

  it("returns recent requests newest-first", () => {
    recordRequestMetrics({ provider: "first", model: "m", status: "ok" });
    recordRequestMetrics({ provider: "second", model: "m", status: "ok" });
    const r = getRecentRequests(10);
    expect(r[0].provider).toBe("second");
    expect(r[1].provider).toBe("first");
  });

  it("caps buffer at 1000", () => {
    for (let i = 0; i < 1100; i++) {
      recordRequestMetrics({ provider: "x", model: "y", status: "ok" });
    }
    expect(getMetricsSummary().bufferSize).toBe(1000);
  });
});
