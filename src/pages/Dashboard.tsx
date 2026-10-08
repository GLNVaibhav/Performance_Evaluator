import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "@/lib/utils";

export default function Dashboard() {
  const runs = useQuery(api.queries.listRuns) ?? [];
  const stats = useQuery(api.queries.stats) ?? { total: 0, active: 0, passed: 0, failed: 0 };

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-10 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">Every evaluation you've approved and executed.</p>
        </div>
        <Link to="/app/new">
          <Button>New evaluation</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="total runs" value={stats.total} />
        <StatCard label="active now" value={stats.active} tone={stats.active > 0 ? "live" : undefined} />
        <StatCard label="thresholds met" value={stats.passed} tone="good" />
        <StatCard label="violations" value={stats.failed} tone="bad" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>Latest first — completed runs keep their full metrics, logs, and analysis.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-10 text-center">
              <p className="text-muted-foreground">No evaluations yet.</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Start with the demo target: <span className="font-mono text-primary/80">Baseline /products with 50 users for 30s</span>
              </p>
              <Link to="/app/new">
                <Button className="mt-4">Create your first run</Button>
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {runs.map((r) => (
                <Link
                  key={r._id}
                  to={`/app/runs/${r._id}`}
                  className="flex items-center justify-between gap-4 py-3 px-2 -mx-2 rounded-md hover:bg-secondary/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-primary">#{r._id.slice(-6)}</span>
                      <StatusChip run={r} />
                      {r.plan && (
                        <span className="text-xs text-muted-foreground">
                          {r.engineMode === "real" || r.executionMode === "live_k6_pending" ? (
                            <>probe · {r.plan.testType} · requested {r.plan.targetVus} VUs</>
                          ) : r.executionMode === "live_k6" ? (
                            <>
                              <span className="text-emerald-400/90 font-mono">LIVE_K6</span> · {r.plan.testType} ·{" "}
                              {r.plan.targetVus} VUs
                            </>
                          ) : (
                            <>{r.plan.testType} · {r.plan.targetVus} VUs</>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground/80 mt-0.5 font-mono">
                      {r.targetBaseUrl} · {r.objective}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-muted-foreground">{relativeTime(r.createdAt)}</div>
                    {r.metrics && (
                      <div className="font-mono text-xs text-muted-foreground/80 mt-0.5">
                        p95 {r.metrics.p95}ms · {(r.metrics.errorRate * 100).toFixed(1)}% err
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "live" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl font-semibold",
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : tone === "live" ? "text-amber-400" : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatusChip({ run }: { run: { status: string; thresholdStatus?: string; engineMode?: string; executionMode?: string; verdictLabel?: string } }) {
  if (run.status === "completed") {
    const label =
      run.verdictLabel ??
      (run.engineMode === "real" ? (run.thresholdStatus === "PASS" ? "PROBE_THRESHOLD_PASS" : "PROBE_THRESHOLD_FAIL") : run.thresholdStatus);
    return <Badge variant={run.thresholdStatus === "PASS" ? "success" : "destructive"}>{label}</Badge>;
  }
  if (run.status === "submitted") {
    return (
      <Badge variant="warning" className="gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-dot" /> on k6 plane
      </Badge>
    );
  }
  if (run.status === "execution_error") return <Badge variant="destructive">error</Badge>;
  if (run.status === "running") {
    return (
      <Badge variant="warning" className="gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-dot" /> running
      </Badge>
    );
  }
  return <Badge variant="secondary">queued</Badge>;
}
