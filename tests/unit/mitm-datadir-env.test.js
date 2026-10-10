import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildPrivilegedEnv } = require("../../src/mitm/manager.js");

describe("buildPrivilegedEnv (A5)", () => {
  it("pins DATA_DIR explicitly for the privileged child", () => {
    const env = buildPrivilegedEnv("http://localhost:20128", "test-key");
    const dataDirLine = env.find((l) => l.startsWith("DATA_DIR="));
    expect(dataDirLine).toBeDefined();
    // shell-quoted, non-empty value
    expect(dataDirLine.length).toBeGreaterThan("DATA_DIR=''".length);
  });

  it("passes through HOME, ROUTER_API_KEY, MITM_ROUTER_BASE and NODE_ENV", () => {
    const env = buildPrivilegedEnv("http://localhost:9999", "test-key");
    const joined = env.join(" ");
    expect(joined).toContain("HOME=");
    expect(joined).toContain("ROUTER_API_KEY=");
    expect(joined).toContain("MITM_ROUTER_BASE='http://localhost:9999'");
    expect(joined).toContain("NODE_ENV=production");
  });

  it("shell-quotes values with spaces", () => {
    const env = buildPrivilegedEnv("http://localhost:20128", "test-key");
    const homeLine = env.find((l) => l.startsWith("HOME="));
    // value is single-quoted
    expect(homeLine).toMatch(/^HOME='.*'$/);
  });
});
