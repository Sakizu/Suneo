import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordFailure,
  _clearRegistryForTests,
  getProviderBreakerRetryAfterMs,
} from "../../open-sse/utils/circuitBreaker.js";
import { unavailableResponse } from "../../open-sse/utils/error.js";
import { formatRetryAfter, checkFallbackError } from "../../open-sse/services/accountFallback.js";

beforeEach(() => {
  _clearRegistryForTests();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
});

describe("breaker-open sentinel", () => {
  it("sentinel shape matches what handlers expect from allRateLimited", () => {
    // Force provider breaker OPEN
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const retryAfterMs = getProviderBreakerRetryAfterMs("openai");
    expect(retryAfterMs).toBeGreaterThan(0);

    // Build sentinel exactly as auth.js does
    const retryAfterAt = Date.now() + retryAfterMs;
    const sentinel = {
      allRateLimited: true,
      retryAfter: retryAfterAt,
      retryAfterHuman: formatRetryAfter(retryAfterAt),
      lastError: `Circuit breaker OPEN for provider "openai"`,
      lastErrorCode: 503,
      circuitOpen: true,
    };

    // Handlers check: if (!credentials || credentials.allRateLimited)
    expect(!sentinel || sentinel.allRateLimited).toBe(true);
    // Handlers read these fields:
    expect(sentinel.lastError).toContain("Circuit breaker OPEN");
    expect(Number(sentinel.lastErrorCode)).toBe(503);
    expect(sentinel.circuitOpen).toBe(true);
  });

  it("sentinel → unavailableResponse → 503 with Retry-After header", async () => {
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const retryAfterMs = getProviderBreakerRetryAfterMs("openai");
    const retryAfterAt = Date.now() + retryAfterMs;
    const sentinel = {
      allRateLimited: true,
      retryAfter: retryAfterAt,
      retryAfterHuman: formatRetryAfter(retryAfterAt),
      lastError: `Circuit breaker OPEN for provider "openai"`,
      lastErrorCode: 503,
      circuitOpen: true,
    };

    // Simulate handler: const status = lastStatus || Number(credentials.lastErrorCode) || 503
    const status = Number(sentinel.lastErrorCode) || 503;
    expect(status).toBe(503);

    const res = unavailableResponse(
      status,
      `[openai/gpt-4] ${sentinel.lastError}`,
      sentinel.retryAfter,
      sentinel.retryAfterHuman
    );
    expect(res.status).toBe(503);
    const retryAfterHeader = res.headers.get("retry-after");
    expect(retryAfterHeader).toBeTruthy();
    const secs = parseInt(retryAfterHeader, 10);
    // Should be ~30s (default cooldown), at least 1s, not NaN
    expect(secs).toBeGreaterThanOrEqual(1);
    expect(secs).toBeLessThanOrEqual(31);
    const body = await res.json();
    expect(body.error.message).toContain("Circuit breaker OPEN");
  });

  it("retryAfter is a valid timestamp (not NaN) for new Date()", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const retryAfterMs = getProviderBreakerRetryAfterMs("openai");
    const retryAfterAt = Date.now() + retryAfterMs;
    // unavailableResponse does: new Date(retryAfter).getTime()
    const parsed = new Date(retryAfterAt).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThan(Date.now());
  });

  it("combo: 503 from breaker-open sentinel triggers fallback to next model", () => {
    // handleSingleModelChat returns 503 via unavailableResponse when it gets
    // the sentinel. Combo then decides via checkFallbackError.
    const { shouldFallback } = checkFallbackError(
      503,
      'Circuit breaker OPEN for provider "openai" (retry after 30s)'
    );
    expect(shouldFallback).toBe(true);
  });
});
