import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from '@/lib/dataDir';

const MACHINE_ID_FILE = path.join(getDataDir(), 'machine-id');
const AUTH_DIR = path.join(getDataDir(), 'auth');
const CLI_SECRET_FILE = path.join(AUTH_DIR, 'cli-secret');
const CLI_AUTH_SALT = '9r-cli-auth';
let cachedRawId = null;
let cachedCliSecret = null;

// Stable install-specific ID: generated once via crypto.randomUUID(), persisted
// 0600. Replaces node-machine-id (native binding unavailable on Termux/Android;
// its catch-fallback generated a fresh randomUUID() per restart, silently
// rotating every derived ID). The file already took precedence before, so on
// machines where it exists behavior is unchanged.
//
// Creation is atomic (`wx` flag): the server and the CLI are separate
// processes that can both reach this code on a fresh install, and the CLI
// snapshots its x-9r-cli-token at startup. Without atomicity the loser of the
// race would derive a different token and eat 401s for its process lifetime.
function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    if (cachedRawId) return cachedRawId;
  } catch {}
  const fresh = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(MACHINE_ID_FILE), { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, fresh, { mode: 0o600, flag: 'wx' });
    cachedRawId = fresh;
  } catch {
    // Lost the creation race (EEXIST) or unwritable dir — re-read whatever won.
    try {
      cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim() || fresh;
    } catch {
      cachedRawId = fresh;
    }
  }
  return cachedRawId;
}

// Random secret persisted on first run → unpredictable CLI token even when machineId leaks.
// Same atomic-creation discipline as loadRawMachineId: the CLI and the server
// can both reach this on a fresh install, and the CLI snapshots its token at
// startup, so the loser must adopt the winner's secret, not its own.
function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, fresh, { mode: 0o600, flag: 'wx' });
    cachedCliSecret = fresh;
  } catch {
    try {
      cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim() || fresh;
    } catch {
      cachedCliSecret = fresh;
    }
  }
  return cachedCliSecret;
}

export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || 'endpoint-proxy-salt';
  const raw = loadRawMachineId();
  const extra = saltValue === CLI_AUTH_SALT ? loadCliSecret() : '';
  return crypto.createHash('sha256').update(raw + saltValue + extra).digest('hex').substring(0, 16);
}

export async function getRawMachineId() {
  return loadRawMachineId();
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}
