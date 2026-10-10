const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "suneo";
const LEGACY_APP_NAMES = ["sakizu", "9router"];

function dirFor(appName) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }
  return path.join(os.homedir(), `.${appName}`);
}

function defaultDir() {
  const dir = dirFor(APP_NAME);
  // One-time migration from legacy data dir names (~/.9router → ~/.sakizu → ~/.suneo).
  // Atomic rename; if it fails we keep serving the legacy dir (never an empty
  // new one). If both exist the new one wins. Never throws.
  try {
    for (const legacyName of LEGACY_APP_NAMES) {
      const legacy = dirFor(legacyName);
      if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
        fs.renameSync(legacy, dir);
        console.log(`[DATA_DIR] migrated legacy data dir → ${dir}`);
        break;
      }
    }
  } catch (e) {
    console.warn(`[DATA_DIR] legacy migration failed (${e && e.message || e})`);
    try {
      for (const legacyName of LEGACY_APP_NAMES) {
        const legacy = dirFor(legacyName);
        if (fs.existsSync(legacy)) return legacy;
      }
    } catch {}
  }
  return dir;
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
