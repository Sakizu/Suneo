import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
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

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { TOKEN_SAVER_HEADER } = await import("../../open-sse/config/runtimeConfig.js");

// pxpipe only acts on Claude-format bodies, so drive the core with an
// Anthropic provider and a real transform double.
const bigText = "x".repeat(30000);

function baseArgs(overrides = {}) {
  return {
    body: {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: bigText }],
    },
    modelInfo: { provider: "anthropic", model: "claude-fable-5" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "test-conn",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: true,
    pxpipeMinChars: 25000,
    pxpipeTimeoutMs: 15000,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
    ...overrides,
  };
}

describe("PXPIPE respects the token-saver bypass header (A1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    });
  });

  it("skips pxpipe when the bypass header is 'off', even with pxpipeEnabled=true", async () => {
    const transform = vi.fn();
    const headers = { accept: "application/json" };
    headers[TOKEN_SAVER_HEADER] = "off";

    await handleChatCore(
      baseArgs({
        pxpipeTransform: transform,
        clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers },
      })
    );

    expect(transform).not.toHaveBeenCalled();
  });

  it("still applies pxpipe when the bypass header is absent", async () => {
    const outBody = { model: "claude-fable-5", messages: [] };
    const transform = vi.fn(async () => ({
      applied: true,
      reason: "applied",
      body: new TextEncoder().encode(JSON.stringify(outBody)),
      info: { compressedChars: 25000, imageCount: 2, imageBytes: 5000, imagePixels: 1500000 },
      cache: { ownsCacheControl: true, markerCount: 1 },
    }));

    await handleChatCore(baseArgs({ pxpipeTransform: transform }));

    expect(transform).toHaveBeenCalled();
  });

  it("treats header value case-insensitively ('OFF' also bypasses)", async () => {
    const transform = vi.fn();
    const headers = { accept: "application/json" };
    headers[TOKEN_SAVER_HEADER] = "OFF";

    await handleChatCore(
      baseArgs({
        pxpipeTransform: transform,
        clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers },
      })
    );

    expect(transform).not.toHaveBeenCalled();
  });
});
