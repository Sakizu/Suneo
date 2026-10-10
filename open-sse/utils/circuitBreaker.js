/**
 * Dual circuit breaker — per-provider + per-connection.
 *
 * Design adapted from OmniRoute's open-sse/services/connectionCircuitBreaker.ts
 * (MIT, Copyright (c) 2026 diegosouzapw) via Vanszs/VansRouter's
 * open-sse/utils/circuitBreaker.js port; state machine + integration rewritten
 * clean-room for our error taxonomy (open-sse/services/accountFallback.js).
 *
 * Breaker selection (OmniRoute logic):
 *   network error / 5xx → per-provider breaker  (`provider`)
 *   401/403             → per-connection breaker (`provider::conn::<connectionId>`)
 *
 * Never counted: 429 (drives account rotation), content-filter refusals
 * (answer about the request, not provider health), client aborts.
 *
 * Kill-switch: set CIRCUIT_BREAKER_ENABLED=false to disable entirely.
 * When disabled, record* are no-ops and is*Open always return false —
 * behavior is identical to "no breaker installed".
 *
 * In-memory only. Restart resets everything to CLOSED (fail-closed to normal).
 */

export const STATE = {
  CLOSED: "CLOSED",
  DEGRADED: "DEGRADED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

// Provider-level: the endpoint is down for everyone.
const PROVIDER_FAILURE_CODES = new Set([408, 500, 502, 503, 504, 520, 524]);
// Local stream lifecycle errors are client-side, not provider failures.
// Ported from VansRouter (Vanszs/VansRouter).
export function isLocalStreamLifecycleError(error) {
  if (!error) return false;
  const message =
    typeof error === "string"
      ? error
      : typeof error.message === "string"
        ? error.message
        : "";
  return /controller is already closed/i.test(message);
}
// Connection-level: 401 is unambiguous auth failure. 403 is AMBIGUOUS — only
// counted if the body matches explicit auth patterns (see classifyFailure).
const CONNECTION_FAILURE_CODES = new Set([401]);
const NETWORK_ERROR_CODES = new Set(
  ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "EPIPE"]
);
const FETCH_NETWORK_RE = /failed to fetch|networkerror|network request failed/i;
// Content-filter detection (second layer): coarse substring match. Only triggers
// on explicit keywords; if unsure, the failure counts normally ("jangan hitung kalau ragu"
// applies to AMBIGUOUS statuses like 403, not to this explicit opt-out).
// Updated 2026-10-08 with real sample from Atria:
// "The request contains sensitive content. Please modify your input and try again."
const CONTENT_FILTER_RES = [
  /content.filter/i,
  /\bmoderation\b/i,
  /\bsafety\b/i,
  /policy.violation/i,
  /sensitive.content/i,
];
// Explicit auth-failure patterns for ambiguous 403. 403 is NOT counted unless the
// body matches one of these — a 403 without clear auth wording is ignored.
const AUTH_FAILURE_RES = [
  /invalid.api.key/i,
  /api.key.*(invalid|expired|revoked|not.valid)/i,
  /\bunauthorized\b/i,
  /authentication.failed/i,
  /invalid.credentials/i,
  /invalid.token/i,
  /token.*(expired|invalid|revoked)/i,
];

const DEFAULTS = {
  failureThreshold: 5,      // failures → OPEN
  failureWindowMs: 60_000,  // sliding window
  resetTimeoutMs: 30_000,   // cooldown → HALF_OPEN probe
  halfOpenRequests: 1,      // probes per cycle
  degradationRatio: 0.6,    // 60% of threshold → DEGRADED warning
  maxBackoffMultiplier: 16, // exponential backoff cap on repeated failed probes
};

/** Env kill-switch. Default enabled; set CIRCUIT_BREAKER_ENABLED=false to disable. */
export function isCircuitBreakerEnabled() {
  return process.env.CIRCUIT_BREAKER_ENABLED !== "false";
}

/** Classify a failure. Pure function — unit-testable in isolation.
 * Conservative: ambiguous statuses (esp. 403) are NOT counted unless the body
 * matches explicit patterns. 401, 5xx, timeout, network always count.
 */
export function classifyFailure({ statusCode = 0, error = null, errorText = "" } = {}) {
  const text = errorText || (error && error.message) || "";
  if (statusCode === 429) return { level: "ignore", reason: "rate_limit" };
  if (CONTENT_FILTER_RES.some((re) => re.test(text)))
    return { level: "ignore", reason: "content_filter" };
  if (error && error.name === "AbortError")
    return { level: "ignore", reason: "client_abort" };
  // Local stream lifecycle errors (e.g. "controller is already closed") are
  // client-side stream issues, not provider failures. Ported from VansRouter.
  if (isLocalStreamLifecycleError(error))
    return { level: "ignore", reason: "stream_lifecycle" };
  const code = (error && error.code) || "";
  if (NETWORK_ERROR_CODES.has(code)) return { level: "provider", isNetworkError: true };
  if (error instanceof TypeError && FETCH_NETWORK_RE.test(error.message || ""))
    return { level: "provider", isNetworkError: true };
  if (CONNECTION_FAILURE_CODES.has(statusCode)) return { level: "connection" };
  // 403 is ambiguous (auth? content filter? other?) — only count if the body
  // has explicit auth-failure wording. Otherwise ignore ("jangan hitung kalau ragu").
  if (statusCode === 403) {
    if (AUTH_FAILURE_RES.some((re) => re.test(text)))
      return { level: "connection", reason: "auth_403" };
    return { level: "ignore", reason: "ambiguous_403" };
  }
  if (PROVIDER_FAILURE_CODES.has(statusCode)) return { level: "provider" };
  return { level: "ignore", reason: "unclassified" };
}

/** OmniRoute's selection logic, verbatim semantics. */
export function breakerNameFor(provider, connectionId, classification) {
  if (classification.level === "connection" && connectionId) {
    return `${provider}::conn::${connectionId}`;
  }
  return provider;
}

export class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
    this.halfOpenRemaining = 0;
    this.openProbeCycles = 0;
    this.failureTimestamps = [];
    this.failureConnectionIds = new Set();
    this.probeTriedIds = new Set(); // accounts tried in current HALF_OPEN cycle
    this.accountCount = 1; // updated via setProviderAccountCount
    this.multiAccount = false; // true if provider has >=2 active accounts
    const o = { ...DEFAULTS, ...options };
    this.failureThreshold = o.failureThreshold;
    this.failureWindowMs = o.failureWindowMs;
    this.resetTimeoutMs = o.resetTimeoutMs;
    this.halfOpenRequests = o.halfOpenRequests;
    this.degradationThreshold = Math.floor(o.failureThreshold * o.degradationRatio);
    this.maxBackoffMultiplier = o.maxBackoffMultiplier;
    this._history = [];
  }

  _transition(to) {
    this._history.push({ from: this.state, to, at: new Date().toISOString() });
    if (this._history.length > 20) this._history.shift();
    this.state = to;
    if (to === STATE.OPEN) { this.openedAt = Date.now(); this.halfOpenRemaining = 0; }
    else if (to === STATE.HALF_OPEN) {
      this.halfOpenRemaining = this.halfOpenRequests;
      this.probeTriedIds.clear(); // fresh rotation cycle
    }
    else if (to === STATE.CLOSED) {
      this.failureCount = 0; this.successCount = 0;
      this.openProbeCycles = 0; this.openedAt = null; this.failureTimestamps = [];
      this.failureConnectionIds.clear();
      this.probeTriedIds.clear();
    }
  }

  _failuresInWindow() {
    if (!this.failureWindowMs) return this.failureCount;
    const cutoff = Date.now() - this.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts >= cutoff);
    return this.failureTimestamps.length;
  }

  /** Also advances OPEN → HALF_OPEN when the cooldown has expired. */
  canExecute() {
    if (this.state === STATE.CLOSED || this.state === STATE.DEGRADED) return true;
    if (this.state === STATE.OPEN) {
      const elapsed = Date.now() - (this.openedAt || Date.now());
      const mult = Math.min(2 ** Math.floor(this.openProbeCycles / 3), this.maxBackoffMultiplier);
      if (elapsed >= this.resetTimeoutMs * mult) {
        this._transition(STATE.HALF_OPEN);
        return true;
      }
      return false;
    }
    if (this.state === STATE.HALF_OPEN) {
      // Allow probe if not all accounts tried yet (rotation).
      // Falls back to halfOpenRemaining for single-account (default behavior).
      if (this.probeTriedIds.size < this.accountCount) return true;
      if (this.halfOpenRemaining > 0) { this.halfOpenRemaining--; return true; }
      return false;
    }
    return true;
  }

  onSuccess() {
    this.successCount++;
    if (this.state === STATE.HALF_OPEN) this._transition(STATE.CLOSED);
    else if (this.state === STATE.DEGRADED && this.successCount >= this.failureThreshold) {
      this._transition(STATE.CLOSED);
    } else if (this.state === STATE.CLOSED) {
      // Symmetric with onFailure (which resets successCount): a success clears
      // the failure window. Prevents interleaved successes from being ignored
      // while failures accumulate (e.g. A&C dead, B healthy via fallback).
      this.failureCount = 0;
      this.failureTimestamps = [];
      this.failureConnectionIds.clear();
    }
  }

  onFailure(connectionId = null) {
    this.failureCount++;
    this.successCount = 0;
    // Track distinct accounts contributing failures (for multi-account guard).
    if (connectionId) this.failureConnectionIds.add(connectionId);
    if (this.failureWindowMs) this.failureTimestamps.push(Date.now());
    if (this.state === STATE.HALF_OPEN) {
      // Probe rotation (2026-10-08): don't re-OPEN immediately. Track tried accounts;
      // re-OPEN only after all accounts tried. Allows healthy B to get probe after dead A.
      // If connectionId unknown (null), can't rotate → re-OPEN (conservative).
      if (!connectionId) {
        this.openProbeCycles++;
        this._transition(STATE.OPEN);
        return;
      }
      this.probeTriedIds.add(connectionId);
      if (this.probeTriedIds.size >= this.accountCount) {
        this.openProbeCycles++; // all accounts tried, all failed → back off harder
        this._transition(STATE.OPEN);
      }
      // else: stay HALF_OPEN, allow next account to probe
      return;
    }
    if (this.state === STATE.OPEN) return;
    const n = this._failuresInWindow();
    // Multi-account guard: provider breaker only trips if failures come from
    // >=2 different accounts, OR the provider has only 1 active account.
    // Prevents a single dead proxy/account from DOSing healthy accounts.
    const distinctAccounts = this.failureConnectionIds.size;
    const multiAccountGuard = !this.multiAccount || distinctAccounts >= 2 || this.accountCount <= 1;
    if (n >= this.failureThreshold && multiAccountGuard) this._transition(STATE.OPEN);
    else if (n >= this.degradationThreshold && this.state === STATE.CLOSED) {
      this._transition(STATE.DEGRADED);
    }
  }

  getRetryAfterMs() {
    if (this.state !== STATE.OPEN || !this.openedAt) return 0;
    const mult = Math.min(2 ** Math.floor(this.openProbeCycles / 3), this.maxBackoffMultiplier);
    return Math.max(0, this.resetTimeoutMs * mult - (Date.now() - this.openedAt));
  }

  reset() { this._transition(STATE.CLOSED); }

  getStatus() {
    return {
      name: this.name, state: this.state,
      failureCount: this.failureCount, successCount: this.successCount,
      retryAfterMs: this.getRetryAfterMs(), openedAt: this.openedAt,
      transitions: this._history.slice(-5),
    };
  }
}

const registry = new Map();
function getBreaker(name) {
  let b = registry.get(name);
  if (!b) { b = new CircuitBreaker(name); registry.set(name, b); }
  return b;
}

/** Set the active account count for a provider (for multi-account guard).
 * Called from auth.js where connections are known. */
export function setProviderAccountCount(provider, count) {
  if (!isCircuitBreakerEnabled() || !provider) return;
  const b = getBreaker(provider);
  b.accountCount = count;
  b.multiAccount = count >= 2;
}

/** Is the provider breaker in HALF_OPEN probe state? */
export function isProviderBreakerHalfOpen(provider) {
  if (!isCircuitBreakerEnabled() || !provider) return false;
  const b = registry.get(provider);
  return b ? b.state === STATE.HALF_OPEN : false;
}

/** Account IDs already tried in the current HALF_OPEN probe cycle.
 * Used by auth.js to rotate probe across accounts (skip tried ones). */
export function getProviderBreakerProbeTriedIds(provider) {
  if (!isCircuitBreakerEnabled() || !provider) return [];
  const b = registry.get(provider);
  return b && b.state === STATE.HALF_OPEN ? [...b.probeTriedIds] : [];
}

/** Record a failure against the right breaker. Returns the breaker or null (ignored). */
export function recordFailure({ provider, connectionId = null, statusCode = 0, error = null, errorText = "", log = null } = {}) {
  if (!isCircuitBreakerEnabled()) return null;
  if (!provider) return null;
  const c = classifyFailure({ statusCode, error, errorText });
  if (c.level === "ignore") return null;
  const breaker = getBreaker(breakerNameFor(provider, connectionId, c));
  breaker.onFailure(connectionId);
  if (breaker.state === STATE.OPEN) {
    log?.warn?.("BREAKER", `${breaker.name} OPEN (${c.level}) after ${breaker.failureCount} failures`);
  } else if (breaker.state === STATE.DEGRADED) {
    log?.debug?.("BREAKER", `${breaker.name} DEGRADED (${breaker.failureCount}/${breaker.failureThreshold})`);
  }
  return breaker;
}

/** Success resets the account's breaker and closes a HALF_OPEN provider probe. */
export function recordSuccess(provider, connectionId = null) {
  if (!isCircuitBreakerEnabled()) return;
  if (!provider) return;
  if (connectionId) {
    const cb = registry.get(`${provider}::conn::${connectionId}`);
    if (cb) cb.onSuccess();
  }
  const pb = registry.get(provider);
  if (pb) pb.onSuccess();
}

export function isProviderBreakerOpen(provider) {
  if (!isCircuitBreakerEnabled()) return false;
  const b = registry.get(provider);
  return b ? !b.canExecute() : false;
}

export function isConnectionBreakerOpen(provider, connectionId) {
  if (!isCircuitBreakerEnabled()) return false;
  if (!connectionId) return false;
  const b = registry.get(`${provider}::conn::${connectionId}`);
  return b ? !b.canExecute() : false;
}

export function getProviderBreakerRetryAfterMs(provider) {
  if (!isCircuitBreakerEnabled()) return 0;
  const b = registry.get(provider);
  return b ? b.getRetryAfterMs() : 0;
}

// Manual reset + introspection (future dashboard/API use).
export function resetBreaker(name) { registry.get(name)?.reset(); }
export function getBreakerStatuses() { return [...registry.values()].map((b) => b.getStatus()); }
// Test-only: clear the module registry between tests.
export function _clearRegistryForTests() { registry.clear(); }

export class CircuitBreakerOpenError extends Error {
  constructor(provider, retryAfterMs) {
    super(`Circuit breaker OPEN for provider "${provider}" — retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitBreakerOpenError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}
