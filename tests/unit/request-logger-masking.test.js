import { describe, it, expect } from "vitest";
import { maskSensitiveHeaders } from "../../open-sse/utils/requestLogger.js";

describe("maskSensitiveHeaders (A2)", () => {
  it("masks authorization bearer tokens", () => {
    const token = "sk-ant-" + "a".repeat(60);
    const out = maskSensitiveHeaders({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    expect(out["content-type"]).toBe("application/json");
    expect(out.authorization).not.toContain(token);
    expect(out.authorization.startsWith("Bearer sk-")).toBe(true); // first 10 chars kept
    expect(out.authorization).toMatch(/\.\.\./); // masked form: first10 + "..." + last5
    expect(out.authorization.endsWith("aaaaa")).toBe(true);
  });

  it("masks x-api-key, cookie and token headers case-insensitively", () => {
    const out = maskSensitiveHeaders({
      "X-API-Key": "x".repeat(40),
      Cookie: "session=" + "y".repeat(40),
      "X-Custom-Token": "z".repeat(40),
    });
    expect(out["X-API-Key"]).toMatch(/\.\.\./);
    expect(out["X-API-Key"]).not.toContain("x".repeat(40));
    expect(out.Cookie).toMatch(/\.\.\./);
    expect(out["X-Custom-Token"]).toMatch(/\.\.\./);
  });

  it("leaves short values and non-sensitive headers untouched", () => {
    const out = maskSensitiveHeaders({
      authorization: "short",
      "content-type": "application/json",
      "x-request-id": "abc123",
    });
    expect(out.authorization).toBe("short");
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-request-id"]).toBe("abc123");
  });

  it("handles null/undefined/empty input", () => {
    expect(maskSensitiveHeaders(null)).toEqual({});
    expect(maskSensitiveHeaders(undefined)).toEqual({});
    expect(maskSensitiveHeaders({})).toEqual({});
  });

  it("does not mutate the input object", () => {
    const input = { authorization: "Bearer " + "k".repeat(50) };
    const snapshot = { ...input };
    maskSensitiveHeaders(input);
    expect(input).toEqual(snapshot);
  });
});
