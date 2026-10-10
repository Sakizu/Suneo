import fs from "node:fs";
import path from "node:path";

let cachedVersion = null;

export function getAppVersion() {
  if (cachedVersion) return cachedVersion;
  // Build-time injected version (next.config.mjs `env`). Falls back to a
  // package.json read only when the env is unset (dev), so SEA-packaged
  // builds don't depend on package.json sitting next to the binary.
  cachedVersion = process.env.NINE_ROUTER_VERSION || null;
  if (!cachedVersion) {
    try {
      const pkgPath = path.join(process.cwd(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      cachedVersion = pkg.version || "0.0.0";
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
}

export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
