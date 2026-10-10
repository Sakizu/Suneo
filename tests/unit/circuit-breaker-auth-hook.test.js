import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn().mockResolvedValue([]),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const {
  recordFailure,
  _clearRegistryForTests,
} = await import("../../open-sse/utils/circuitBreaker.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const CONN_A = { id: "acc-a", connectionName: "A", isActive: true, accessToken: "tok-a" };
const CONN_B = { id: "acc-b", connectionName: "B", isActive: true, accessToken: "tok-b" };

beforeEach(() => {
  _clearRegistryForTests();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
  vi.useFakeTimers();
  mocks.getProviderConnections.mockResolvedValue([CONN_A, CONN_B]);
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
});

describe("auth.js breaker hook (sentinel design)", () => {
  it("provider OPEN → returns allRateLimited sentinel (not throw, not null)", async () => {
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const creds = await getProviderCredentials("openai", null, "gpt-4");
    // NOT null (null → 404 in chat.js), NOT throw
    expect(creds).not.toBeNull();
    expect(creds.allRateLimited).toBe(true);
    expect(creds.circuitOpen).toBe(true);
    expect(creds.lastError).toContain("Circuit breaker OPEN");
    expect(creds.lastErrorCode).toBe(503);
    expect(creds.retryAfter).toBeGreaterThan(Date.now());
    expect(creds.retryAfterHuman).toBeTruthy();
  });

  it("provider OPEN → sentinel even when connections exist", async () => {
    // Connections exist but provider breaker is open → sentinel, not a connection
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const creds = await getProviderCredentials("openai", null, "gpt-4");
    expect(creds.allRateLimited).toBe(true);
    // Should NOT return a connection object
    expect(creds.accessToken).toBeUndefined();
  });

  it("connection breaker OPEN for A → A filtered, B selected", async () => {
    // 5x 401 on account A → per-connection breaker for A opens
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", connectionId: "acc-a", statusCode: 401 });
    }
    const creds = await getProviderCredentials("openai", null, "gpt-4");
    // A is skipped, B is selected
    expect(creds).not.toBeNull();
    expect(creds.allRateLimited).toBeUndefined();
    expect(creds.connectionId).toBe("acc-b");
  });

  it("kill-switch disables the hook", async () => {
    process.env.CIRCUIT_BREAKER_ENABLED = "false";
    for (let i = 0; i < 5; i++) {
      recordFailure({ provider: "openai", statusCode: 503 });
    }
    const creds = await getProviderCredentials("openai", null, "gpt-4");
    // Breaker disabled → normal connection selected, no sentinel
    expect(creds.allRateLimited).toBeUndefined();
    expect(creds.circuitOpen).toBeUndefined();
    expect(creds.connectionId).toBe("acc-a"); // fill-first picks first
  });
});
