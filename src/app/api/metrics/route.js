import { NextResponse } from "next/server";
import { getMetricsSummary, getRecentRequests } from "open-sse/utils/metrics.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit"), 10) || 50, 200);
    const summary = getMetricsSummary();
    const recent = getRecentRequests(limit);
    return NextResponse.json({ ...summary, recent });
  } catch (error) {
    console.error("[API] Failed to get metrics:", error);
    return NextResponse.json({ error: "Failed to fetch metrics" }, { status: 500 });
  }
}
