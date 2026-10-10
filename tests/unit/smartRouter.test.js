import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("open-sse/utils/circuitBreaker.js", () => ({
  isProviderBreakerOpen: vi.fn(() => false),
}));

vi.mock("open-sse/utils/metrics.js", () => ({
  getMetricsSummary: vi.fn(() => ({
    windows: {
      "1h": {
        byProvider: {
          fast: { count: 100, errors: 0, p50: 200, p95: 400 },
          slow: { count: 100, errors: 0, p50: 2000, p95: 4000 },
          flaky: { count: 100, errors: 50, p50: 300, p95: 600 },
        },
      },
    },
  })),
}));

const { scoreProviderWithData, rankModelsByHealth } = await import("open-sse/utils/smartRouter.js");
const { getRotatedModels } = await import("open-sse/services/combo.js");

describe("scoreProviderWithData", () => {
  it("scores fast+reliable lowest", () => {
    const byProvider = {
      fast: { count: 100, errors: 0, p50: 200 },
      slow: { count: 100, errors: 0, p50: 2000 },
    };
    const fastScore = scoreProviderWithData("fast", byProvider);
    const slowScore = scoreProviderWithData("slow", byProvider);
    expect(fastScore).toBeLessThan(slowScore);
  });

  it("penalizes errors heavily", () => {
    const byProvider = {
      clean: { count: 100, errors: 0, p50: 5000 },
      flaky: { count: 100, errors: 50, p50: 100 },
    };
    const cleanScore = scoreProviderWithData("clean", byProvider);
    const flakyScore = scoreProviderWithData("flaky", byProvider);
    // 50% errors should outweigh even 50x latency difference
    expect(flakyScore).toBeGreaterThan(cleanScore);
  });

  it("returns null for unknown provider", () => {
    expect(scoreProviderWithData("nope", {})).toBeNull();
  });
});

describe("rankModelsByHealth", () => {
  it("ranks fast provider first", () => {
    const models = ["slow/model-a", "fast/model-b", "flaky/model-c"];
    const ranked = rankModelsByHealth(models);
    expect(ranked[0]).toBe("fast/model-b");
    expect(ranked[ranked.length - 1]).toBe("flaky/model-c");
  });

  it("returns input as-is for 0-1 models", () => {
    expect(rankModelsByHealth([])).toEqual([]);
    expect(rankModelsByHealth(["a/b"])).toEqual(["a/b"]);
  });
});

describe("getRotatedModels smart strategy", () => {
  it("uses smart ranking when strategy=smart", () => {
    const models = ["slow/a", "fast/b"];
    const result = getRotatedModels(models, "test", "smart");
    expect(result[0]).toBe("fast/b");
  });

  it("falls back to input order for unknown strategy", () => {
    const models = ["slow/a", "fast/b"];
    expect(getRotatedModels(models, "test", "fallback")).toEqual(models);
  });
});
