"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Badge, Button } from "@/shared/components";


function formatRetry(ms) {
  if (!ms || ms <= 0) return "—";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

export default function BreakersPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/breakers");
      const json = await res.json();
      setData(json);
    } catch {
      setData({ enabled: false, breakers: [], error: "Failed to fetch" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleReset = async (name) => {
    setResetting(name);
    try {
      await fetch("/api/breakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await fetchData();
    } finally {
      setResetting(null);
    }
  };

  if (loading) return <div className="p-6">Loading breakers...</div>;

  const breakers = data?.breakers || [];
  const open = breakers.filter((b) => b.state === "OPEN");
  const halfOpen = breakers.filter((b) => b.state === "HALF_OPEN");

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Circuit Breakers</h1>
        <Badge variant={data?.enabled ? "success" : "default"}>
          {data?.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      {!data?.enabled && (
        <Card className="p-4">
          <p className="text-sm text-gray-500">
            Circuit breaker is disabled (CIRCUIT_BREAKER_ENABLED=false).
          </p>
        </Card>
      )}

      {data?.enabled && breakers.length === 0 && (
        <Card className="p-4">
          <p className="text-sm text-gray-500">
            No breakers have recorded failures yet. All quiet.
          </p>
        </Card>
      )}

      {(open.length > 0 || halfOpen.length > 0) && (
        <Card className="p-4 border-red-200">
          <h2 className="font-semibold text-red-600 mb-2">
            {open.length} OPEN, {halfOpen.length} HALF_OPEN
          </h2>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {breakers.map((b) => (
          <Card key={b.name} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-sm truncate" title={b.name}>
                {b.name}
              </span>
              <Badge variant={b.state === "OPEN" ? "error" : b.state === "HALF_OPEN" ? "warning" : "success"}>{b.state}</Badge>
            </div>
            <div className="text-sm space-y-1 text-gray-600">
              <div>Failures: <span className="font-medium">{b.failureCount}</span></div>
              <div>Successes: <span className="font-medium">{b.successCount}</span></div>
              <div>Retry in: <span className="font-medium">{formatRetry(b.retryAfterMs)}</span></div>
              <div>Opened: <span className="font-medium">{formatTime(b.openedAt)}</span></div>
            </div>
            {b.state !== "CLOSED" && (
              <Button
                size="sm"
                className="mt-3"
                disabled={resetting === b.name}
                onClick={() => handleReset(b.name)}
              >
                {resetting === b.name ? "Resetting..." : "Reset"}
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
