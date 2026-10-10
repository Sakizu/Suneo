import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// terminalUI is CJS; requiring it pulls its menu deps — they must not crash on import.
const { renderHeader, maskKey } = require("../../cli/src/cli/terminalUI.js");

const FULL_KEY = "sk-abc123def456ghi789jkl012mno345pqr678stu901";

describe("maskKey (A3)", () => {
  it("masks with first-6 + bullets + last-4, same as dashboard", () => {
    const out = maskKey(FULL_KEY);
    expect(out.startsWith(FULL_KEY.slice(0, 6))).toBe(true);
    expect(out.endsWith(FULL_KEY.slice(-4))).toBe(true);
    expect(out).toContain("•");
    expect(out).not.toContain(FULL_KEY);
    expect(out.length).toBe(FULL_KEY.length);
  });

  it("passes through short/empty values", () => {
    expect(maskKey("short")).toBe("short");
    expect(maskKey("")).toBe("");
    expect(maskKey(null)).toBe("");
  });
});

describe("renderHeader (A3)", () => {
  it("never prints a full API key", () => {
    const keys = [{ key: FULL_KEY }, { key: "sk-secondkey1234567890abcdef1234567890" }];
    const out = renderHeader(20128, keys, null);
    expect(out).not.toContain(FULL_KEY);
    expect(out).not.toContain("sk-secondkey1234567890abcdef1234567890");
    // masked forms are present
    expect(out).toContain(maskKey(FULL_KEY));
  });

  it("still renders without keys", () => {
    const out = renderHeader(20128, [], null);
    expect(out).toContain("No API keys yet");
  });
});
