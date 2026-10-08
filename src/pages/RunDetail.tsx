import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link, useParams } from "react-router-dom";
import { AiAnalysisPanel } from "@/components/AiAnalysisPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { LineChart } from "@/components/LineChart";
import { cn, formatMs, formatNumber } from "@/lib/utils";

const PHASE_COLORS: Record<string, string> = {
  init: "text-sky-400",
  plan: "text-sky-300",
  probe: "text-violet-400",
  engine: "text-violet-300",
  breakpoint: "text-amber-400",
  degraded: "text-red-400",
  teardown: "text-muted-foreground",
  verdict: "text-emerald-400",
};

function EngineModeBadge({ run }: { run: { engineMode?: string } }) {
  if (!run.engineMode) return null;
  return run.engineMode === "real" ? (
    <Badge variant="secondary" className="font-mono text-[10px] gap-1.5 border-emerald-500/40 text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      real traffic
    </Badge>
  ) : (
    <Badge variant="secondary" className="font-mono text-[10px] gap-1.5 border-amber-500/40 text-amber-400">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      simulation
    </Badge>
  );
}

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const run = useQuery(api.queries.getRun, runId ? { runId: runId as never } : "skip");
  const samples = useQuery(api.queries.listSamples, runId ? { runId: runId as never } : "skip") ?? [];
  const logs = useQuery(api.queries.listLogs, runId ? { runId: runId as never } : "skip") ?? [];

  if (run === undefined) {
    return (
      <div className="p-10 text-sm text-muted-foreground font-mono">loading run…</div>
    );
  }
  if (run === null) {
    return (
      <div className="p-10 space-y-3">
        <p className="text-muted-foreground">Run not found (or not yours).</p>
        <Button variant="outline" onClick={() => window.history.back()}>Back</Button>
      </div>
    );
  }

  const running = run.status === "running" || run.status === "queued" || run.status === "submitted";
  const sorted = [...samples].sort((a, b) => a.tSec - b.tSec);
  const m = run.metrics;
  const isReal = run.engineMode === "real";
  const isLiveK6 = run.executionMode === "live_k6" || run.engineMode === "live_k6";
  const isBridgePending = run.executionMode === "live_k6_pending" && !isLiveK6;

  // Requested envelope vs actual measurement (BUG 3): real mode executes a
  // bounded probe (≤4 in-flight), never the planned VU population.
  const requestedVus = run.plan?.targetVus ?? null;
  const actualPeakVus = isReal ? Math.max(0, ...sorted.map((s) => s.vus), 0) : m?.peakVus ?? null;
  const probeRequests = run.probeStats?.requests;
  const elapsedSec = sorted.length ? sorted[sorted.length - 1]!.tSec : null;
  const unverifiedEndpoints = (run.endpointsVerification ?? []).filter((e) => !e.verified);

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-10 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Run {run._id.slice(-8)}</h1>
            <StatusBadge run={run} />
            <EngineModeBadge run={run} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground font-mono">
            {run.plan?.testType} · {run.plan?.objectiveType} ·{" "}
            <span className="text-primary/80">{run.targetBaseUrl}</span>
            {run.externalRunId ? <span className="text-muted-foreground/60"> · ext {run.externalRunId}</span> : null}
          </p>
        </div>
        <div className="flex gap-2">
          {running && (
            <Badge variant="warning" className="font-mono gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
              {run.status === "submitted"
                ? "executing on k6 plane"
                : run.currentVus != null
                  ? `live · ${run.currentVus}${isReal ? " in flight" : " VUs"}`
                  : "live"}
            </Badge>
          )}
          <Link to="/app">
            <Button variant="outline" size="sm">All runs</Button>
          </Link>
        </div>
      </div>

      {running && (
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
              <span className="font-mono">executing staged traffic…</span>
              <span className="font-mono text-primary">{run.progress}%</span>
            </div>
            <Progress value={run.progress} />
          </CardContent>
        </Card>
      )}

      {/* LIVE_K6 execution banner + provenance (Phases 5/7/10) */}
      {(isLiveK6 || isBridgePending) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Execution mode: {isLiveK6 ? "LIVE_K6 (real k6 execution)" : "LIVE_K6 (executing…)"}
            </CardTitle>
            <CardDescription>
              {isLiveK6
                ? "Metrics below originate from the actual k6 results.json — parsed by the execution plane, persisted verbatim, never recomputed."
                : "The approved plan was submitted to the FastAPI execution plane; live k6 execution is in progress."}
            </CardDescription>
          </CardHeader>
          {run.liveProvenance && isLiveK6 && (
            <CardContent>
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 font-mono text-xs">
                <div className="text-emerald-400 mb-1">provenance</div>
                <div className="text-muted-foreground space-y-0.5">
                  <div>engine = {run.liveProvenance.engine}</div>
                  <div>externalRunId = {run.liveProvenance.externalRunId}</div>
                  <div>source = {run.liveProvenance.source}</div>
                  <div>correlationId = {run.liveProvenance.correlationId}</div>
                  <div>completedAt = {new Date(run.liveProvenance.completedAt).toLocaleString()}</div>
                  <div>results.json artifact = {run.liveProvenance.artifactPresent ? "present" : "not recorded"}</div>
                </div>
              </div>
              <RequestedVsObservedDistribution run={run} />
            </CardContent>
          )}
          {isBridgePending && (
            <CardContent>
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 font-mono text-xs text-muted-foreground">
                Submitted to the execution plane. External run id is assigned on acceptance; this run will never be
                silently replaced by a simulation.
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Requested experiment vs actual measurement (real-probe runs) */}
      {isReal && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Execution mode: real HTTP probe
            </CardTitle>
            <CardDescription>
              A bounded probe (≤4 concurrent GETs) — reachability, latency and status observation. It is not a
              {run.plan?.objectiveType === "boundary_search" ? " boundary search" : ` ${run.plan?.testType} test`}: the requested load was not executed.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-[10px] uppercase tracking-wider text-amber-400/90">Requested experiment</div>
              <div className="mt-1 font-mono text-sm text-foreground">
                {run.plan?.testType} / {run.plan?.objectiveType}
              </div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                requested envelope: {requestedVus ?? "—"} VUs
                {run.plan?.objectiveType === "boundary_search"
                  ? ` (${run.plan?.rampDuration ?? "?"} ramp + ${run.plan?.holdDuration ?? "?"} hold)`
                  : ` for ${run.plan?.duration ?? "?"}`}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground/70">not executed as load</div>
            </div>
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="text-[10px] uppercase tracking-wider text-emerald-400/90">Actual measurement</div>
              <div className="mt-1 font-mono text-sm text-foreground">
                {probeRequests ?? m?.totalRequests ?? "—"} requests · ≤4 concurrent
                {elapsedSec != null ? ` · ${elapsedSec}s` : ""}
              </div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                peak measured in-flight: {actualPeakVus ?? "—"}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground/70">bounded real HTTP probe</div>
            </div>
            <div className="rounded-lg border border-border/60 bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Inference</div>
              <div className="mt-1 text-sm text-muted-foreground">
                No saturation/capacity inference. Evidence covers HTTP status + latency of this probe only.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Result metrics */}
      {run.status === "completed" && m && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Metric label="requests" value={formatNumber(m.totalRequests)} />
            <Metric label="p50" value={formatMs(m.p50)} />
            <Metric label="p95" value={formatMs(m.p95)} tone={m.p95 > (run.plan?.thresholds.p95LatencyMs ?? 1000) ? "bad" : "good"} />
            <Metric label="p99" value={formatMs(m.p99)} />
            <Metric label="peak rps" value={formatNumber(m.maxRps)} />
            <Metric
              label="errors"
              value={`${(m.errorRate * 100).toFixed(2)}%`}
              tone={m.errorRate > (run.plan?.thresholds.errorRate ?? 0.05) ? "bad" : "good"}
            />
          </div>

          <Card className={run.thresholdStatus === "PASS" ? "border-emerald-500/30" : "border-red-500/30"}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Verdict
                <Badge variant={run.thresholdStatus === "PASS" ? "success" : "destructive"}>
                  {/* BUG 4: bounded probes get probe-threshold verdicts, never
                      capacity/stress verdicts. */}
                  {run.verdictLabel ?? (run.engineMode === "real" ? (run.thresholdStatus === "PASS" ? "PROBE_THRESHOLD_PASS" : "PROBE_THRESHOLD_FAIL") : run.thresholdStatus)}
                </Badge>
                <span className="text-sm text-muted-foreground font-normal">
                  score {run.score}/100 · via {run.analyzer === "llm" ? "AI analyzer" : "deterministic analyzer"}
                </span>
              </CardTitle>
              <CardDescription>{run.summary}</CardDescription>
            </CardHeader>
            {unverifiedEndpoints.length > 0 && (
              <CardContent>
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 font-mono text-xs">
                  <div className="text-amber-400">endpoint verification (target contract)</div>
                  <div className="mt-1 space-y-0.5 text-muted-foreground">
                    {(run.endpointsVerification ?? []).map((e, i) => (
                      <div key={i}>
                        {e.verified ? "✓" : "✗"} {e.endpoint}
                        {e.status != null ? ` — HTTP ${e.status}` : e.reason ? ` — ${e.reason}` : ""}
                        {e.verified ? " (verified)" : " (could not be established as a valid application/API operation)"}
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            )}
            {run.probeStats && (
              <CardContent>
                <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-3 font-mono text-xs text-muted-foreground">
                  <span className="text-violet-400">probe evidence</span> · {run.probeStats.requests} measured GET requests
                  · {run.probeStats.non2xx} non-2xx · {run.probeStats.networkErrors} network errors
                  <div className="mt-1 text-muted-foreground/70">{run.probeStats.probeUrls.join("  ")}</div>
                </div>
              </CardContent>
            )}
            {(run.thresholdViolations?.length ?? 0) > 0 && (
              <CardContent>
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                  {run.thresholdViolations!.map((v, i) => (
                    <div key={i} className="text-sm text-red-400 font-mono text-xs">✗ {v}</div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>

          {run.analysis && run.analysis.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Analysis</CardTitle>
                <CardDescription>Failure localization and next actions</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2.5">
                  {run.analysis.map((a, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                      <span className="text-primary font-mono text-xs mt-1">▸</span>
                      <span className="text-muted-foreground">{a}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* AI Performance Intelligence (interpretation-only; Phase 9) */}
      {run.status === "completed" && (
        <AiAnalysisPanel subjectKind="run" subjectId={run._id} queryFn={api.aiQueries.latestForRun} />
      )}

      {run.status === "execution_error" && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-red-400">Execution error</CardTitle>
            <CardDescription className="font-mono">{run.errorMessage}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Live charts (k6 runs have no per-second Convex samples — metrics are
          backend-authoritative; charts render only for probe/simulation) */}
      {sorted.length > 0 && !isLiveK6 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Latency</CardTitle>
              <CardDescription>per-second percentiles (ms)</CardDescription>
            </CardHeader>
            <CardContent>
              <LineChart
                series={[
                  { label: "p50", color: "#34d399", values: sorted.map((s) => s.p50) },
                  { label: "p95", color: "#f59e0b", values: sorted.map((s) => s.p95) },
                  { label: "p99", color: "#f87171", values: sorted.map((s) => s.p99) },
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Traffic</CardTitle>
              <CardDescription>
                {isReal ? "measured in-flight &amp; throughput per second (requested VU envelope shown as context only)" : "VUs &amp; throughput per second"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LineChart
                series={
                  isReal
                    ? [
                        { label: "in-flight", color: "#818cf8", values: sorted.map((s) => s.vus) },
                        { label: "req/s", color: "#2dd4bf", values: sorted.map((s) => s.rps) },
                      ]
                    : [
                        { label: "VUs", color: "#818cf8", values: sorted.map((s) => s.vus) },
                        { label: "req/s", color: "#2dd4bf", values: sorted.map((s) => s.rps) },
                      ]
                }
              />
              {isReal && (
                <p className="mt-2 text-[11px] text-muted-foreground/80 font-mono">
                  requested envelope: {requestedVus ?? "—"} VUs (not executed) · measured peak in-flight: {actualPeakVus ?? "—"}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Engine log */}
      {logs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Engine log</CardTitle>
            <CardDescription>probe → plan → ingest → verdict</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-auto scrollbar-thin rounded-md border border-border/60 bg-background/70 p-3 font-mono text-[11px] leading-relaxed">
              {[...logs]
                .sort((a, b) => a.at - b.at)
                .map((l) => (
                  <div key={l._id} className="flex gap-2">
                    <span className="text-muted-foreground/60 shrink-0">[{String(l.at).padStart(3, "0")}s]</span>
                    <span className={cn("shrink-0 w-24", PHASE_COLORS[l.phase] ?? "text-muted-foreground")}>{l.phase}</span>
                    <span className="text-muted-foreground">{l.message}</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Plan */}
      {run.plan && (
        <Card>
          <CardHeader>
            <CardTitle>Compiled plan</CardTitle>
            <CardDescription>What was approved before execution</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto scrollbar-thin rounded-md border border-border/60 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(run.plan, null, 2)}
            </pre>
            {run.plan.assumptions.length > 0 && (
              <ul className="mt-3 space-y-1">
                {run.plan.assumptions.map((a, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex gap-2">
                    <span className="text-primary/70 font-mono">▸</span> {a}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ run }: { run: { status: string; thresholdStatus?: string } }) {
  if (run.status === "completed") {
    return <Badge variant={run.thresholdStatus === "PASS" ? "success" : "destructive"}>{run.thresholdStatus}</Badge>;
  }
  if (run.status === "execution_error") return <Badge variant="destructive">execution_error</Badge>;
  if (run.status === "running") return <Badge variant="warning">running</Badge>;
  return <Badge variant="secondary">queued</Badge>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-lg font-semibold",
          tone === "bad" ? "text-red-400" : tone === "good" ? "text-emerald-400" : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Requested vs observed endpoint distribution (REAL PERFORMANCE
 * EXPERIMENTATION Phase 3). "Requested" is the plan's endpoint weight;
 * "observed" is k6's own per-endpoint request count from the verbatim
 * backend result (externalResult.metrics.per_endpoint, tagged submetrics —
 * never recomputed in Convex). The two are displayed side by side and are
 * never claimed to be identical; when no weights were configured, the row
 * is omitted entirely rather than pretending a mix was requested.
 */
function RequestedVsObservedDistribution({
  run,
}: {
  run: {
    plan?: { selectedEndpoints?: string[]; endpointWeights?: Record<string, number> };
    externalResult?: { metrics?: { per_endpoint?: { endpoint: string; total_requests: number; p95_ms?: number }[] } };
  };
}) {
  const weights = run.plan?.endpointWeights;
  const per = run.externalResult?.metrics?.per_endpoint ?? [];
  if (!weights || Object.keys(weights).length === 0 || per.length === 0) return null;
  const totalWeight = run.plan?.selectedEndpoints?.reduce((s, e) => s + (weights[e] ?? 0), 0) ?? 0;
  if (totalWeight <= 0) return null;
  const totalObserved = per.reduce((s, e) => s + e.total_requests, 0);
  return (
    <div className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
      <div className="text-sky-400 mb-1 font-mono">endpoint distribution — requested (plan weights) vs observed (k6)</div>
      <div className="space-y-1 font-mono">
        {run.plan?.selectedEndpoints?.map((ep) => {
          const requested = (weights[ep] ?? 0) / totalWeight;
          const entry = per.find((e) => e.endpoint === ep);
          const observed = entry && totalObserved > 0 ? entry.total_requests / totalObserved : 0;
          return (
            <div key={ep} className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
              <span>{ep}</span>
              <span>
                requested {(requested * 100).toFixed(1)}% · observed {entry ? `${(observed * 100).toFixed(1)}% (${entry.total_requests} req)` : "no requests recorded"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
        Observed values come from k6's own tagged submetrics, stored verbatim. Requested and observed are shown side by
        side and are not claimed to be identical.
      </p>
    </div>
  );
}
