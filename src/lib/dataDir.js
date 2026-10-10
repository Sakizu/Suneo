import fs from "node:fs";
import path from "path";
import os from "os";

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
    console.warn(`[DATA_DIR] legacy migration failed (${e?.message || e})`);
    try {
      for (const legacyName of LEGACY_APP_NAMES) {
        const legacy = dirFor(legacyName);
        if (fs.existsSync(legacy)) return legacy;
      }
    } catch {}
  }
  return dir;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

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

export const DATA_DIR = getDataDir();
