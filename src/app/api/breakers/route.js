import { NextResponse } from "next/server";
import { getBreakerStatuses, isCircuitBreakerEnabled } from "open-sse/utils/circuitBreaker.js";

export async function GET() {
  const enabled = isCircuitBreakerEnabled();
  const breakers = enabled ? getBreakerStatuses() : [];
  return NextResponse.json({
    enabled,
    count: breakers.length,
    breakers: breakers.map((b) => ({
      name: b.name,
      state: b.state,
      failureCount: b.failureCount,
      successCount: b.successCount,
      retryAfterMs: b.retryAfterMs,
      openedAt: b.openedAt,
      transitions: b.transitions,
    })),
  });
}

export async function POST(request) {
  const { resetBreaker } = await import("open-sse/utils/circuitBreaker.js");
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { name } = body || {};
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Missing breaker name" }, { status: 400 });
  }
  resetBreaker(name);
  return NextResponse.json({ ok: true, reset: name });
}
