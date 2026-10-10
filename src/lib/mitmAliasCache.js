// JSON cache for mitmAlias — read by standalone MITM server (no SQLite native binding).
// Source of truth = SQLite kv['mitmAlias']. JSON is a read-replica synced on app start
// and after every UI write.
import fs from "fs";
import path from "path";
import os from "os";

const DATA_DIR = process.env.DATA_DIR
  || (() => {
    const dirFor = (appName) => process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName)
      : path.join(os.homedir(), `.${appName}`);
    const dir = dirFor("suneo");
    // One-time migration from the legacy data dir name (~/.9router → ~/.suneo → ~/.suneo).
    try {
      const legacy = dirFor("9router");
      if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
        fs.renameSync(legacy, dir);
        console.log(`[DATA_DIR] migrated legacy data dir → ${dir}`);
      }
    } catch (e) {
      console.warn(`[DATA_DIR] legacy migration failed (${e?.message || e})`);
      try { if (fs.existsSync(dirFor("9router"))) return dirFor("9router"); } catch {}
    }
    return dir;
  })();

const CACHE_FILE = path.join(DATA_DIR, "mitm", "aliases.json");

function writeAtomic(data) {
  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_FILE);
}

// Sync entire mitmAlias map from DB → JSON file
export async function syncToJson() {
  try {
    const { getMitmAlias } = await import("@/lib/db/repos/aliasRepo.js");
    const all = await getMitmAlias();
    writeAtomic(all || {});
  } catch (e) {
    console.log("[mitmAliasCache] sync failed:", e.message);
  }
}

// Update cache for a single tool after UI saves to DB
export function writeAliasForTool(tool, mappings) {
  try {
    let current = {};
    if (fs.existsSync(CACHE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* corrupted → reset */ }
    }
    current[tool] = mappings || {};
    writeAtomic(current);
  } catch (e) {
    console.log("[mitmAliasCache] write failed:", e.message);
  }
}
