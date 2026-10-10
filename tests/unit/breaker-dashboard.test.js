import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("open-sse/utils/circuitBreaker.js", () => ({
  isCircuitBreakerEnabled: vi.fn(() => true),
  getBreakerStatuses: vi.fn(() => [
    {
      name: "provider:openai",
      state: "OPEN",
      failureCount: 5,
      successCount: 0,
      retryAfterMs: 15000,
      openedAt: Date.now(),
      transitions: [],
    },
  ]),
  resetBreaker: vi.fn(),
}));

const { GET, POST } = await import("../../src/app/api/breakers/route.js");

describe("GET /api/breakers", () => {
  it("returns breaker statuses", async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.enabled).toBe(true);
    expect(json.count).toBe(1);
    expect(json.breakers[0].name).toBe("provider:openai");
    expect(json.breakers[0].state).toBe("OPEN");
  });
});

describe("POST /api/breakers", () => {
  it("resets a breaker by name", async () => {
    const { resetBreaker } = await import("open-sse/utils/circuitBreaker.js");
    const req = new Request("http://localhost/api/breakers", {
      method: "POST",
      body: JSON.stringify({ name: "provider:openai" }),
    });
    const res = await POST(req);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(resetBreaker).toHaveBeenCalledWith("provider:openai");
  });

  it("400 on missing name", async () => {
    const req = new Request("http://localhost/api/breakers", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
