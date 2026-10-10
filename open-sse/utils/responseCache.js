// Response cache for Suneo — exact-match, non-streaming only.
// Ported from serenhope/9router (open-sse/rtk/semanticCache.js).
// SHA256 of model+messages+system+tools. TTL 3h default, 1000 entry cap.
// Counters make savings visible: hits/misses/saves/evictions.

import crypto from "node:crypto";

const responseCache = new Map();

let cacheTtlMs = 3 * 60 * 60 * 1000;
let maxEntries = 1000;
let enabled = true;

export function setResponseCacheEnabled(v) { enabled = !!v; }
export function isResponseCacheEnabled() { return enabled; }
export function setResponseCacheMaxEntries(n) {
  const v = Math.floor(Number(n));
  if (Number.isFinite(v) && v >= 10) maxEntries = Math.min(v, 10000);
}
export function setResponseCacheTtlMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  cacheTtlMs = Math.min(Math.max(n, 60 * 1000), 30 * 24 * 60 * 60 * 1000);
}

const stats = { hits: 0, misses: 0, saves: 0, evictions: 0 };
export function getResponseCacheStats() {
  return { ...stats, entries: responseCache.size, ttlMs: cacheTtlMs, enabled };
}
export function resetResponseCacheStats() {
  stats.hits = 0; stats.misses = 0; stats.saves = 0; stats.evictions = 0;
}

function hashObject(obj) {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
  } catch {
    return null;
  }
}

function buildKey(body, model) {
  return hashObject({
    model,
    messages: body.messages || body.input || body.contents || [],
    system: body.system,
    tools: body.tools,
  });
}

export function checkResponseCache(body, model) {
  if (!enabled || !body || body.stream) return null;
  if (body.tool_choice && body.tool_choice !== "auto") return null;

  const key = buildKey(body, model);
  if (!key) return null;

  const entry = responseCache.get(key);
  if (!entry) { stats.misses++; return null; }
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    stats.misses++;
    return null;
  }
  stats.hits++;
  return entry.response;
}

export function saveResponseCache(body, model, responseBody) {
  if (!enabled || !body || body.stream || !responseBody) return;
  if (body.tool_choice && body.tool_choice !== "auto") return;
  if (responseBody.error || responseBody.is_error) return;

  const key = buildKey(body, model);
  if (!key) return;

  responseCache.set(key, { response: responseBody, expiresAt: Date.now() + cacheTtlMs });
  stats.saves++;

  if (responseCache.size > maxEntries) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
    stats.evictions++;
  }
}

// Test-only
export function _clearResponseCacheForTests() {
  responseCache.clear();
  resetResponseCacheStats();
}
