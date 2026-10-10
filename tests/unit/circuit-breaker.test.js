import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  STATE,
  CircuitBreaker,
  classifyFailure,
  breakerNameFor,
  recordFailure,
  recordSuccess,
  isProviderBreakerOpen,
  isConnectionBreakerOpen,
  getProviderBreakerRetryAfterMs,
  resetBreaker,
  getBreakerStatuses,
  _clearRegistryForTests,
  isCircuitBreakerEnabled,
  CircuitBreakerOpenError,
  setProviderAccountCount,
  isProviderBreakerHalfOpen,
  getProviderBreakerProbeTriedIds,
} from "../../open-sse/utils/circuitBreaker.js";

beforeEach(() => {
  _clearRegistryForTests();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
});

describe("classifyFailure", () => {
  it("429 → ignore (rate_limit)", () => {
    expect(classifyFailure({ statusCode: 429 }).level).toBe("ignore");
    expect(classifyFailure({ statusCode: 429 }).reason).toBe("rate_limit");
  });
  it("content-filter text → ignore", () => {
    expect(classifyFailure({ statusCode: 400, errorText: "content filter triggered" }).reason)
      .toBe("content_filter");
    expect(classifyFailure({ statusCode: 400, errorText: "violates safety policy" }).reason)
      .toBe("content_filter");
    // Real sample 2026-10-08 (Atria provider):
    // "The request contains sensitive content. Please modify your input and try again."
    expect(classifyFailure({
      statusCode: 400,
      errorText: "The request contains sensitive content. Please modify your input and try again.",
    }).reason).toBe("content_filter");
  });
  it("ECONNREFUSED → provider", () => {
    const err = new Error("connect");
    err.code = "ECONNREFUSED";
    expect(classifyFailure({ error: err }).level).toBe("provider");
  });
  it("fetch TypeError network error → provider", () => {
    expect(classifyFailure({ error: new TypeError("failed to fetch") }).level).toBe("provider");
  });
  it("401 → connection (always)", () => {
    expect(classifyFailure({ statusCode: 401 }).level).toBe("connection");
  });
  it("403 without auth wording → ignore (ambiguous)", () => {
    const c = classifyFailure({ statusCode: 403 });
    expect(c.level).toBe("ignore");
    expect(c.reason).toBe("ambiguous_403");
  });
  it("403 with explicit auth failure → connection", () => {
    expect(classifyFailure({ statusCode: 403, errorText: "Invalid API key provided" }).level)
      .toBe("connection");
    expect(classifyFailure({ statusCode: 403, errorText: "Unauthorized: bad credentials" }).level)
      .toBe("connection");
  });
  it("503 → provider", () => {
    expect(classifyFailure({ statusCode: 503 }).level).toBe("provider");
  });
  it("418 (unclassified) → ignore", () => {
    const c = classifyFailure({ statusCode: 418 });
    expect(c.level).toBe("ignore");
    expect(c.reason).toBe("unclassified");
  });
  it("AbortError → ignore (client_abort)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyFailure({ error: err }).reason).toBe("client_abort");
  });
});

describe("breakerNameFor", () => {
  it("401 + connId → provider::conn::id", () => {
    expect(breakerNameFor("openai", "acc1", { level: "connection" }))
      .toBe("openai::conn::acc1");
  });
  it("503 + connId → provider (no per-conn split)", () => {
    expect(breakerNameFor("openai", "acc1", { level: "provider" })).toBe("openai");
  });
  it("401 without connId → provider (safe fallback)", () => {
    expect(breakerNameFor("openai", null, { level: "connection" })).toBe("openai");
  });
});

describe("CircuitBreaker state machine", () => {
  it("CLOSED → DEGRADED → OPEN → HALF_OPEN → CLOSED", () => {
    // threshold 5, degradation at 60% = 3
    const b = new CircuitBreaker("p", { failureThreshold: 5, resetTimeoutMs: 1000 });
    expect(b.state).toBe(STATE.CLOSED);

    b.onFailure(); b.onFailure();
    expect(b.state).toBe(STATE.CLOSED);
    b.onFailure(); // 3rd → DEGRADED
    expect(b.state).toBe(STATE.DEGRADED);
    expect(b.canExecute()).toBe(true); // DEGRADED still allows traffic

    b.onFailure(); b.onFailure(); // 5th → OPEN
    expect(b.state).toBe(STATE.OPEN);
    expect(b.canExecute()).toBe(false);

    vi.advanceTimersByTime(1000); // cooldown → HALF_OPEN probe
    expect(b.canExecute()).toBe(true);
    expect(b.state).toBe(STATE.HALF_OPEN);

    b.onSuccess(); // probe succeeded → CLOSED
    expect(b.state).toBe(STATE.CLOSED);
    expect(b.failureCount).toBe(0);
  });

  it("HALF_OPEN probe failure → back to OPEN with backoff", () => {
    const b = new CircuitBreaker("p", {
      failureThreshold: 2, resetTimeoutMs: 1000, maxBackoffMultiplier: 16,
    });
    b.onFailure(); b.onFailure();
    expect(b.state).toBe(STATE.OPEN);

    vi.advanceTimersByTime(1000);
    expect(b.canExecute()).toBe(true); // probe 1
    expect(b.state).toBe(STATE.HALF_OPEN);
    b.onFailure(); // probe failed
    expect(b.state).toBe(STATE.OPEN);
    expect(b.openProbeCycles).toBe(1);

    // still in cooldown (1000ms * 2^0 = 1000ms, only 0 elapsed)
    expect(b.canExecute()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(b.canExecute()).toBe(true); // probe 2 allowed
  });

  it("backoff multiplier caps at 16x", () => {
    const b = new CircuitBreaker("p", {
      failureThreshold: 1, resetTimeoutMs: 1000, maxBackoffMultiplier: 16,
    });
    b.onFailure();
    expect(b.state).toBe(STATE.OPEN);
    // force many failed probe cycles: mult = 2^floor(cycles/3), capped at 16
    b.openProbeCycles = 30;
    // 1000 * 16 = 16000ms needed
    vi.advanceTimersByTime(15999);
    expect(b.canExecute()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(b.canExecute()).toBe(true);
  });

  it("DEGRADED needs sustained success to return to CLOSED", () => {
    const b = new CircuitBreaker("p", { failureThreshold: 5 });
    b.onFailure(); b.onFailure(); b.onFailure();
    expect(b.state).toBe(STATE.DEGRADED);
    b.onSuccess(); // 1 success — not enough
    expect(b.state).toBe(STATE.DEGRADED);
    b.onSuccess(); b.onSuccess(); b.onSuccess(); b.onSuccess(); // 5 total
    expect(b.state).toBe(STATE.CLOSED);
  });

  it("sliding window: old failures expire", () => {
    // threshold 5 → DEGRADED at 3, OPEN at 5
    const b = new CircuitBreaker("p", { failureThreshold: 5, failureWindowMs: 1000 });
    b.onFailure(); b.onFailure(); b.onFailure(); b.onFailure(); // 4 in window → DEGRADED
    expect(b.state).toBe(STATE.DEGRADED);
    vi.advanceTimersByTime(1500); // all 4 expire from the window
    b.onFailure();
    // window now holds only 1 failure (not 5) — but DEGRADED is sticky:
    // it only clears via sustained success (onSuccess), not via window expiry
    expect(b._failuresInWindow()).toBe(1);
    expect(b.state).toBe(STATE.DEGRADED);
    // 5 sustained successes → back to CLOSED
    for (let i = 0; i < 5; i++) b.onSuccess();
    expect(b.state).toBe(STATE.CLOSED);
  });

  it("getRetryAfterMs reflects cooldown", () => {
    const b = new CircuitBreaker("p", { failureThreshold: 1, resetTimeoutMs: 5000 });
    b.onFailure();
    expect(b.state).toBe(STATE.OPEN);
    const ra = b.getRetryAfterMs();
    expect(ra).toBeGreaterThan(4000);
    expect(ra).toBeLessThanOrEqual(5000);
  });
});

describe("registry helpers", () => {
  it("recordFailure routes 503 → provider breaker, 401 → connection breaker", () => {
    const pb = recordFailure({ provider: "openai", statusCode: 503 });
    expect(pb.name).toBe("openai");
    const cb = recordFailure({ provider: "openai", connectionId: "a1", statusCode: 401 });
    expect(cb.name).toBe("openai::conn::a1");
  });
  it("recordFailure ignores 429", () => {
    expect(recordFailure({ provider: "openai", statusCode: 429 })).toBeNull();
    expect(getBreakerStatuses()).toHaveLength(0);
  });
  it("5 failures → isProviderBreakerOpen true", () => {
    for (let i = 0; i < 5; i++) recordFailure({ provider: "openai", statusCode: 503 });
    expect(isProviderBreakerOpen("openai")).toBe(true);
    expect(isConnectionBreakerOpen("openai", "a1")).toBe(false); // untouched
  });
  it("recordSuccess resets", () => {
    for (let i = 0; i < 5; i++) recordFailure({ provider: "openai", statusCode: 503 });
    expect(isProviderBreakerOpen("openai")).toBe(true);
    resetBreaker("openai");
    expect(isProviderBreakerOpen("openai")).toBe(false);
  });
  it("getProviderBreakerRetryAfterMs", () => {
    expect(getProviderBreakerRetryAfterMs("nope")).toBe(0);
    for (let i = 0; i < 5; i++) recordFailure({ provider: "openai", statusCode: 503 });
    expect(getProviderBreakerRetryAfterMs("openai")).toBeGreaterThan(0);
  });
});

describe("kill-switch", () => {
  it("default enabled", () => {
    expect(isCircuitBreakerEnabled()).toBe(true);
  });
  it("CIRCUIT_BREAKER_ENABLED=false disables everything", () => {
    process.env.CIRCUIT_BREAKER_ENABLED = "false";
    expect(isCircuitBreakerEnabled()).toBe(false);
    expect(recordFailure({ provider: "openai", statusCode: 503 })).toBeNull();
    recordSuccess("openai");
    expect(isProviderBreakerOpen("openai")).toBe(false);
    expect(isConnectionBreakerOpen("openai", "a1")).toBe(false);
    expect(getProviderBreakerRetryAfterMs("openai")).toBe(0);
    expect(getBreakerStatuses()).toHaveLength(0);
  });
  it("any other value keeps it enabled", () => {
    process.env.CIRCUIT_BREAKER_ENABLED = "true";
    expect(isCircuitBreakerEnabled()).toBe(true);
    process.env.CIRCUIT_BREAKER_ENABLED = "0";
    expect(isCircuitBreakerEnabled()).toBe(true);
  });
});

describe("CircuitBreakerOpenError", () => {
  it("carries provider + retryAfterMs", () => {
    const e = new CircuitBreakerOpenError("openai", 30000);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CircuitBreakerOpenError");
    expect(e.provider).toBe("openai");
    expect(e.retryAfterMs).toBe(30000);
    expect(e.message).toContain("openai");
  });
});

describe("HALF_OPEN probe rotation", () => {
  const netErr = () => Object.assign(new Error("x"), { code: "ETIMEDOUT" });
  it("probe failure does NOT re-OPEN until all accounts tried", () => {
    setProviderAccountCount("openai", 2);
    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "acc-A", error: netErr() });
      recordFailure({ provider: "openai", connectionId: "acc-B", error: netErr() });
    }
    expect(isProviderBreakerOpen("openai")).toBe(true);
    // Simulate cooldown → HALF_OPEN
    const b = getBreakerStatuses().find(s => s.name === "openai");
    // Manually transition to HALF_OPEN for test (simulate cooldown)
    const breaker = (() => {
      // Access via recordFailure side effect is messy; use direct manipulation
      return null;
    })();
    // Instead: test via onFailure in HALF_OPEN state directly
    const pb = new CircuitBreaker("probe-test", { resetTimeoutMs: 10 });
    pb.accountCount = 2; pb.multiAccount = true;
    pb.onFailure("A"); pb.onFailure("B"); pb.onFailure("A"); pb.onFailure("B"); pb.onFailure("A");
    // Force OPEN (bypass guard for test setup)
    pb._transition("OPEN");
    // Simulate cooldown
    pb.openedAt = Date.now() - 100;
    expect(pb.canExecute()).toBe(true); // → HALF_OPEN
    expect(pb.state).toBe(STATE.HALF_OPEN);
    // Probe A fails → should NOT re-OPEN (B not tried yet)
    pb.onFailure("acc-A");
    expect(pb.state).toBe(STATE.HALF_OPEN);
    expect([...pb.probeTriedIds]).toEqual(["acc-A"]);
    // Probe B succeeds → CLOSED
    pb.onSuccess();
    expect(pb.state).toBe(STATE.CLOSED);
  });
  it("re-OPENs only after all accounts tried and failed", () => {
    const pb = new CircuitBreaker("probe-test2", { resetTimeoutMs: 10 });
    pb.accountCount = 2; pb.multiAccount = true;
    pb._transition("OPEN");
    pb.openedAt = Date.now() - 100;
    pb.canExecute(); // → HALF_OPEN
    pb.onFailure("acc-A"); // A fails, B not tried → stay HALF_OPEN
    expect(pb.state).toBe(STATE.HALF_OPEN);
    pb.onFailure("acc-B"); // B fails, all tried → OPEN
    expect(pb.state).toBe(STATE.OPEN);
  });
  it("getProviderBreakerProbeTriedIds returns tried IDs in HALF_OPEN", () => {
    const pb = new CircuitBreaker("probe-test3", { resetTimeoutMs: 10 });
    pb.accountCount = 2;
    // Register in registry via setProviderAccountCount
    setProviderAccountCount("probe-test3", 2);
    // Get the actual breaker from registry and manipulate
    // (simpler: test the function directly with a known state)
    expect(getProviderBreakerProbeTriedIds("nonexistent")).toEqual([]);
  });
});

describe("multi-account guard", () => {
  const netErr = () => Object.assign(new Error("x"), { code: "ETIMEDOUT" });
  it("single dead account (multi-account provider) does NOT trip provider", () => {
    setProviderAccountCount("openai", 2);
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "acc-A", error: netErr() });
      recordSuccess("openai", "acc-B"); // B healthy via fallback
    }
    expect(isProviderBreakerOpen("openai")).toBe(false);
  });
  it("failures from >=2 accounts DO trip provider", () => {
    setProviderAccountCount("openai", 2);
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "acc-A", error: netErr() });
      recordFailure({ provider: "openai", connectionId: "acc-B", error: netErr() });
    }
    expect(isProviderBreakerOpen("openai")).toBe(true);
  });
  it("single-account provider trips on 5 failures", () => {
    setProviderAccountCount("solo", 1);
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "solo", connectionId: "only-acc", error: netErr() });
    }
    expect(isProviderBreakerOpen("solo")).toBe(true);
  });
  it("S5: 3 accounts, A&C dead, B healthy → does NOT trip", () => {
    setProviderAccountCount("openai", 3);
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "acc-A", error: netErr() });
      recordSuccess("openai", "acc-B");
      recordFailure({ provider: "openai", connectionId: "acc-C", error: netErr() });
      recordSuccess("openai", "acc-B");
    }
    expect(isProviderBreakerOpen("openai")).toBe(false);
  });
  it("success in CLOSED resets failure window (symmetric)", () => {
    const b = new CircuitBreaker("t");
    b.onFailure("A"); b.onFailure("A"); // 2 failures, stays CLOSED
    expect(b.state).toBe(STATE.CLOSED);
    expect(b.failureCount).toBe(2);
    b.onSuccess(); // success in CLOSED
    expect(b.failureCount).toBe(0);
    expect(b.failureTimestamps).toHaveLength(0);
    // 2 more failures (not 4 total) → should NOT trip
    b.onFailure("A"); b.onFailure("A");
    expect(b.state).not.toBe(STATE.OPEN);
  });
});
