import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  recordFailure,
  isProviderBreakerOpen,
  _clearRegistryForTests,
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

function netErr() {
  return Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
}
function resp503() {
  return new Response(JSON.stringify({ error: { message: "Circuit breaker OPEN" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}
function respOk() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("combo fallback on breaker OPEN", () => {
  it("provider OPEN for model 1 → model 2 runs and succeeds", async () => {
    // Trip breaker for openai (model 1's provider) via 2 accounts failing
    const { setProviderAccountCount } = await import("../../open-sse/utils/circuitBreaker.js");
    setProviderAccountCount("openai", 2);
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "a1", error: netErr() });
      recordFailure({ provider: "openai", connectionId: "a2", error: netErr() });
    }
    expect(isProviderBreakerOpen("openai")).toBe(true);
    expect(isProviderBreakerOpen("anthropic")).toBe(false);

    const called = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      called.push(modelStr);
      // Simulate real sentinel path: breaker OPEN → 503
      if (modelStr === "openai/gpt-4" && isProviderBreakerOpen("openai")) {
        return resp503();
      }
      // Model 2 (anthropic) succeeds
      return respOk();
    });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4", "anthropic/claude-3"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });

    // Model 1 attempted (503), fallback to model 2, model 2 succeeds
    expect(called).toEqual(["openai/gpt-4", "anthropic/claude-3"]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("does NOT fallback when breaker CLOSED (model 1 succeeds)", async () => {
    const called = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      called.push(modelStr);
      return respOk();
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4", "anthropic/claude-3"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });
    expect(called).toEqual(["openai/gpt-4"]);
    expect(result.ok).toBe(true);
  });
});
