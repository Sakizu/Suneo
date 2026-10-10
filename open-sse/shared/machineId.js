import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir";

let cachedRawId = null;
const MACHINE_ID_FILE = path.join(getDataDir(), "machine-id");

// Stable install-specific ID persisted 0600, shared with src/shared/utils/machineId.js.
// Replaces node-machine-id: native binding unavailable on Termux/Android, and its
// catch-fallback (fresh randomUUID per restart) silently rotated derived IDs.
function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (cachedRawId) return cachedRawId;
  } catch {}
  cachedRawId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(MACHINE_ID_FILE), { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, cachedRawId, { mode: 0o600 });
  } catch {}
  return cachedRawId;
}

export async function getConsistentMachineId(salt = "endpoint-proxy-salt") {
  const rawId = loadRawMachineId();
  return crypto.createHash("sha256").update(rawId + salt).digest("hex").substring(0, 16);
}
