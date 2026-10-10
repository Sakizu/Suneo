import { describe, it, expect, beforeEach } from "vitest";
import {
  checkResponseCache,
  saveResponseCache,
  getResponseCacheStats,
  _clearResponseCacheForTests,
} from "open-sse/utils/responseCache.js";
import { isLocalStreamLifecycleError } from "open-sse/utils/circuitBreaker.js";

describe("responseCache", () => {
  beforeEach(() => _clearResponseCacheForTests());

  it("misses on empty cache", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(checkResponseCache(body, "gpt-4")).toBeNull();
    expect(getResponseCacheStats().misses).toBe(1);
  });

  it("hits after save", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const resp = { choices: [{ message: { content: "hello" } }] };
    saveResponseCache(body, "gpt-4", resp);
    expect(checkResponseCache(body, "gpt-4")).toEqual(resp);
    expect(getResponseCacheStats().hits).toBe(1);
  });

  it("skips streaming", () => {
    const body = { stream: true, messages: [] };
    saveResponseCache(body, "gpt-4", { ok: 1 });
    expect(checkResponseCache(body, "gpt-4")).toBeNull();
  });

  it("skips error responses", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    saveResponseCache(body, "gpt-4", { error: "bad" });
    expect(checkResponseCache(body, "gpt-4")).toBeNull();
  });

  it("different model = different key", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    saveResponseCache(body, "gpt-4", { a: 1 });
    expect(checkResponseCache(body, "gpt-3.5")).toBeNull();
  });
});

describe("isLocalStreamLifecycleError", () => {
  it("detects controller closed", () => {
    expect(isLocalStreamLifecycleError(new Error("controller is already closed"))).toBe(true);
    expect(isLocalStreamLifecycleError("Controller is already closed")).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isLocalStreamLifecycleError(new Error("timeout"))).toBe(false);
    expect(isLocalStreamLifecycleError(null)).toBe(false);
    expect(isLocalStreamLifecycleError(undefined)).toBe(false);
  });
});
