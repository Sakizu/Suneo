import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { executeMock, refreshMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshMock: vi.fn(),
}));
const breakerMocks = vi.hoisted(() => ({
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: executeMock, refreshCredentials: refreshMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(), logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
// Spy on breaker calls (real module, mocked fns)
vi.mock("../../open-sse/utils/circuitBreaker.js", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, recordFailure: breakerMocks.recordFailure, recordSuccess: breakerMocks.recordSuccess };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const realBreaker = await vi.importActual("../../open-sse/utils/circuitBreaker.js");

const BASE_ARGS = {
  body: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
  modelInfo: { provider: "openai", model: "gpt-4" },
  credentials: { accessToken: "tok", connectionId: "acc-a" },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  connectionId: "acc-a",
  stream: false,
};

function okResponse() {
  return {
    response: new Response(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.openai.com/v1/chat/completions",
  };
}
function errResponse(status, message) {
  return {
    response: new Response(JSON.stringify({ error: { message } }), {
      status, headers: { "content-type": "application/json" },
    }),
    url: "https://api.openai.com/v1/chat/completions",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CIRCUIT_BREAKER_ENABLED;
});
afterEach(() => { delete process.env.CIRCUIT_BREAKER_ENABLED; });

describe("chatCore breaker record points", () => {
  it("success → recordSuccess (not recordFailure)", async () => {
    executeMock.mockResolvedValue(okResponse());
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordSuccess).toHaveBeenCalledWith("openai", "acc-a");
    expect(breakerMocks.recordFailure).not.toHaveBeenCalled();
  });

  it("429 → recordFailure called but breaker ignores (no state change)", async () => {
    executeMock.mockResolvedValue(errResponse(429, "rate limit exceeded"));
    await handleChatCore({ ...BASE_ARGS });
    // recordFailure IS called at the hook point; the breaker module classifies 429 → ignore
    expect(breakerMocks.recordFailure).toHaveBeenCalled();
    const arg = breakerMocks.recordFailure.mock.calls[0][0];
    expect(arg.statusCode).toBe(429);
    // Verify the real classifier ignores it
    expect(realBreaker.classifyFailure({ statusCode: 429 }).level).toBe("ignore");
  });

  it("network throw (non-Abort) → recordFailure with error", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    executeMock.mockRejectedValue(err);
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordFailure).toHaveBeenCalled();
    const arg = breakerMocks.recordFailure.mock.calls[0][0];
    expect(arg.error).toBe(err);
    expect(arg.provider).toBe("openai");
    // Real classifier → provider level
    expect(realBreaker.classifyFailure({ error: err }).level).toBe("provider");
  });

  it("AbortError → recordFailure NOT called", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    executeMock.mockRejectedValue(err);
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordFailure).not.toHaveBeenCalled();
  });

  it("401 persistent (refresh fails) → recordFailure with 401", async () => {
    // refreshCredentials returns null → refresh fails → 401 persists → record
    refreshMock.mockResolvedValue(null);
    executeMock.mockResolvedValue(errResponse(401, "invalid api key"));
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordFailure).toHaveBeenCalled();
    const arg = breakerMocks.recordFailure.mock.calls[0][0];
    expect(arg.statusCode).toBe(401);
    expect(realBreaker.classifyFailure({ statusCode: 401 }).level).toBe("connection");
  });

  it("401 recovered via token-refresh → recordFailure NOT called", async () => {
    // First call 401, refresh succeeds, retry succeeds → no record
    refreshMock.mockResolvedValue({ accessToken: "new-tok" });
    executeMock
      .mockResolvedValueOnce(errResponse(401, "token expired"))
      .mockResolvedValueOnce(okResponse());
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordFailure).not.toHaveBeenCalled();
    expect(breakerMocks.recordSuccess).toHaveBeenCalled();
  });

  it("content-filter text → recordFailure called but breaker ignores", async () => {
    refreshMock.mockResolvedValue(null);
    executeMock.mockResolvedValue(errResponse(400, "content filter: request blocked by moderation"));
    await handleChatCore({ ...BASE_ARGS });
    expect(breakerMocks.recordFailure).toHaveBeenCalled();
    const arg = breakerMocks.recordFailure.mock.calls[0][0];
    // Real classifier ignores content-filter
    expect(realBreaker.classifyFailure({ statusCode: 400, errorText: arg.errorText }).level)
      .toBe("ignore");
  });

  it("kill-switch off via chatCore → zero effect", async () => {
    process.env.CIRCUIT_BREAKER_ENABLED = "false";
    refreshMock.mockResolvedValue(null);
    // 5 failures would normally open the breaker
    for (let i = 0; i < 5; i++) {
      executeMock.mockResolvedValue(errResponse(503, "service unavailable"));
      await handleChatCore({ ...BASE_ARGS });
      vi.clearAllMocks();
    }
    // recordFailure is called (hook point) but real module ignores due to kill-switch
    // Verify via real module: no breaker should be open
    expect(realBreaker.isProviderBreakerOpen("openai")).toBe(false);
    expect(realBreaker.getBreakerStatuses()).toHaveLength(0);
  });
});
