"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Badge } from "@/shared/components";

function ms(v) {
  if (!v || v <= 0) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function WindowSection({ label, data }) {
  if (!data) return null;
  return (
    <Card className="p-4">
      <h3 className="font-semibold mb-3">{label}</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-gray-500">Requests</div>
          <div className="text-xl font-bold">{data.count}</div>
        </div>
        <div>
          <div className="text-gray-500">Error rate</div>
          <div className="text-xl font-bold text-red-600">
            {(data.errorRate * 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-gray-500">Tokens</div>
          <div className="text-xl font-bold">{data.tokens.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-gray-500">Latency p95</div>
          <div className="text-xl font-bold">{ms(data.total.p95)}</div>
        </div>
      </div>
      <div className="mt-3 text-sm">
        <div className="text-gray-500 mb-1">Latency (total)</div>
        <div className="flex gap-4">
          <span>p50: <b>{ms(data.total.p50)}</b></span>
          <span>p95: <b>{ms(data.total.p95)}</b></span>
          <span>p99: <b>{ms(data.total.p99)}</b></span>
        </div>
      </div>
      {Object.keys(data.byProvider || {}).length > 0 && (
        <div className="mt-3">
          <div className="text-gray-500 text-sm mb-2">By provider</div>
          <div className="space-y-1">
            {Object.entries(data.byProvider).map(([name, p]) => (
              <div key={name} className="flex justify-between text-sm border-t pt-1">
                <span className="font-mono">{name}</span>
                <span>
                  {p.count} req · {ms(p.p50)}/{ms(p.p95)} ·{" "}
                  <span className={p.errors > 0 ? "text-red-600" : "text-green-600"}>
                    {p.errors} err
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function ObservePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics?limit=30");
      setData(await res.json());
    } catch {
      setData({ error: "Failed to fetch" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (loading) return <div className="p-6">Loading metrics...</div>;
  if (data?.error) return <div className="p-6 text-red-600">{data.error}</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Observability</h1>
        <Badge variant="default">{data?.bufferSize || 0} in buffer</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <WindowSection label="Last 5 minutes" data={data?.windows?.["5m"]} />
        <WindowSection label="Last hour" data={data?.windows?.["1h"]} />
        <WindowSection label="Last 24 hours" data={data?.windows?.["24h"]} />
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-3">Recent requests</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2">Time</th>
                <th className="pb-2">Provider</th>
                <th className="pb-2">Model</th>
                <th className="pb-2">TTFT</th>
                <th className="pb-2">Total</th>
                <th className="pb-2">Tokens</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent || []).map((r, i) => (
                <tr key={i} className="border-b">
                  <td className="py-1">{new Date(r.ts).toLocaleTimeString()}</td>
                  <td className="font-mono">{r.provider}</td>
                  <td className="font-mono text-xs">{r.model?.slice(0, 30)}</td>
                  <td>{ms(r.ttftMs)}</td>
                  <td>{ms(r.totalMs)}</td>
                  <td>{r.tokens?.toLocaleString()}</td>
                  <td>
                    <Badge variant={r.status === "ok" ? "success" : "error"}>
                      {r.status === "ok" ? "ok" : r.errorType || "error"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!data?.recent || data.recent.length === 0) && (
            <p className="text-sm text-gray-500 py-4">No requests recorded yet.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
