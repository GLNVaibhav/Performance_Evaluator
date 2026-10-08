import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "react-router-dom";
import { api } from "@convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Experiment comparison (REAL PERFORMANCE EXPERIMENTATION Phase 7).
 *
 * STRICT SCOPE: factual numeric differences between completed LIVE_K6 runs
 * only. No overall score, no better/worse verdict, no ranking, no derived
 * quality index — the brief explicitly forbids them. Every cell is either a
 * recorded measurement from the run's verbatim k6 result or a plain
 * arithmetic difference between two such measurements, labelled as such.
 */
type RunDoc = {
  _id: string;
  status: string;
  executionMode?: string;
  engineMode?: string;
  thresholdStatus?: string;
  createdAt?: number;
  targetBaseUrl?: string;
  plan?: {
    objectiveType: string;
    testType: string;
    targetVus: number;
    duration?: string;
    rampDuration?: string;
    holdDuration?: string;
    selectedEndpoints: string[];
    endpointWeights?: Record<string, number>;
  };
  metrics?: {
    totalRequests: number;
    totalFailures: number;
    errorRate: number;
    p50: number;
    p95: number;
    p99: number;
    maxRps: number;
    peakVus: number;
    latencyAvgMs?: number;
    latencyMaxMs?: number;
  };
  externalResult?: {
    metrics?: {
      per_endpoint?: {
        endpoint: string;
        total_requests: number;
        p95_ms: number;
        error_rate: number;
      }[];
    };
  };
};

const MAX_SELECTED = 3;

export default function Compare() {
  const runs = (useQuery(api.queries.listRuns) ?? []) as unknown as RunDoc[];
  const [searchParams] = useSearchParams();
  const preselect = searchParams.get("with");
  const [selected, setSelected] = useState<string[]>(() => (preselect ? [preselect] : []));

  const eligible = useMemo(
    () =>
      runs.filter(
        (r) =>
          r.status === "completed" &&
          (r.executionMode === "live_k6" || r.engineMode === "live_k6") &&
          r.metrics,
      ),
    [runs],
  );

  const chosen = useMemo(
    () =>
      selected
        .map((id) => eligible.find((r) => r._id === id))
        .filter((r): r is RunDoc => !!r),
    [selected, eligible],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SELECTED) return [...prev.slice(1), id];
      return [...prev, id];
    });
  }

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compare experiments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Factual numeric differences between completed LIVE_K6 runs. No score, ranking, or
          better/worse verdict is computed — numbers only.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select 2–{MAX_SELECTED} completed LIVE_K6 runs</CardTitle>
          <CardDescription>
            {eligible.length} eligible run{eligible.length === 1 ? "" : "s"} in your history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {eligible.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Not enough completed LIVE_K6 runs yet — run more experiments first.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {eligible.map((r) => {
                const isSel = selected.includes(r._id);
                return (
                  <button
                    key={r._id}
                    onClick={() => toggle(r._id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-4 py-2.5 px-2 -mx-2 rounded-md text-left transition-colors",
                      isSel ? "bg-primary/10" : "hover:bg-secondary/40",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-3.5 w-3.5 rounded-sm border text-[9px] leading-none flex items-center justify-center font-mono",
                            isSel ? "bg-primary border-primary text-primary-foreground" : "border-border",
                          )}
                        >
                          {isSel ? "✓" : ""}
                        </span>
                        <span className="font-mono text-sm text-primary">#{r._id.slice(-6)}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.plan?.objectiveType} · {r.plan?.targetVus} VUs ·{" "}
                          {r.plan?.duration ?? `ramp ${r.plan?.rampDuration} + hold ${r.plan?.holdDuration}`} ·{" "}
                          {r.plan?.selectedEndpoints?.join(", ")}
                        </span>
                      </div>
                    </div>
                    <span className="text-right shrink-0 font-mono text-xs text-muted-foreground">
                      {r.metrics?.totalRequests} req · p95 {r.metrics?.p95?.toFixed(1)}ms ·{" "}
                      {((r.metrics?.errorRate ?? 0) * 100).toFixed(1)}% err ·{" "}
                      <Badge variant={r.thresholdStatus === "PASS" ? "success" : "destructive"}>
                        {r.thresholdStatus}
                      </Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {chosen.length >= 2 && <ComparisonTable runs={chosen} />}
    </div>
  );
}

function fmt(n: number | undefined, unit = "", dp = 2): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: dp })}${unit}`;
}

function ComparisonTable({ runs }: { runs: RunDoc[] }) {
  const pair = runs.length === 2;
  const a = runs[0];
  const b = runs[1];

  const rows: {
    label: string;
    get: (r: RunDoc) => number | undefined;
    unit?: string;
    dp?: number;
    pct?: boolean; // format value as percentage
    diffable?: boolean; // show absolute/relative delta for the 2-run case
  }[] = [
    { label: "Requested VUs", get: (r) => r.plan?.targetVus, dp: 0 },
    { label: "Executed peak VUs", get: (r) => r.metrics?.peakVus, dp: 0 },
    { label: "Requests (observed)", get: (r) => r.metrics?.totalRequests, dp: 0, diffable: true },
    { label: "RPS (observed)", get: (r) => r.metrics?.maxRps, diffable: true },
    { label: "p50 (ms)", get: (r) => r.metrics?.p50, diffable: true },
    { label: "p95 (ms)", get: (r) => r.metrics?.p95, diffable: true },
    { label: "p99 (ms)", get: (r) => r.metrics?.p99, diffable: true },
    { label: "Average (ms)", get: (r) => r.metrics?.latencyAvgMs, diffable: true },
    { label: "Max (ms)", get: (r) => r.metrics?.latencyMaxMs, diffable: true },
    { label: "Error rate", get: (r) => r.metrics?.errorRate, pct: true, diffable: true },
    { label: "Failed requests", get: (r) => r.metrics?.totalFailures, dp: 0, diffable: true },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Observed values, side by side</CardTitle>
        <CardDescription>
          Every cell is a recorded measurement from that run's verbatim k6 result
          (k6 → FastAPI → Convex, unmuted). The Δ column is a plain arithmetic difference
          between the two measurements — it is not a judgment.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Metric</th>
              {runs.map((r) => (
                <th key={r._id} className="py-2 px-3 font-medium font-mono">
                  #{r._id.slice(-6)}
                  {r.thresholdStatus ? (
                    <span className={cn("ml-2", r.thresholdStatus === "PASS" ? "text-emerald-400" : "text-red-400")}>
                      {r.thresholdStatus}
                    </span>
                  ) : null}
                </th>
              ))}
              {pair && <th className="py-2 px-3 font-medium">Δ ({a ? `#${a._id.slice(-6)}` : ""} → {b ? `#${b._id.slice(-6)}` : ""})</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((row) => {
              const vals = runs.map((r) => row.get(r));
              return (
                <tr key={row.label}>
                  <td className="py-2 pr-4 text-muted-foreground">{row.label}</td>
                  {vals.map((v, i) => (
                    <td key={i} className="py-2 px-3 font-mono">
                      {row.pct ? fmt(v !== undefined ? v * 100 : undefined, "%") : fmt(v, row.unit ?? "", row.dp)}
                    </td>
                  ))}
                  {pair && row.diffable && typeof vals[0] === "number" && typeof vals[1] === "number" && (
                    <td className="py-2 px-3 font-mono text-muted-foreground">
                      {renderDelta(vals[0]!, vals[1]!, !!row.pct)}
                    </td>
                  )}
                  {pair && (!row.diffable || typeof vals[0] !== "number" || typeof vals[1] !== "number") && (
                    <td className="py-2 px-3 text-muted-foreground">—</td>
                  )}
                </tr>
              );
            })}
            <tr>
              <td className="py-2 pr-4 text-muted-foreground align-top">Endpoint distribution (observed)</td>
              <td className="py-2 px-3" colSpan={runs.length + (pair ? 1 : 0)}>
                <EndpointDistribution runs={runs} />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-4 text-[11px] text-muted-foreground/80">
          Requested durations:{" "}
          {runs
            .map(
              (r) =>
                `#${r._id.slice(-6)} ${r.plan?.duration ?? `ramp ${r.plan?.rampDuration} + hold ${r.plan?.holdDuration}`}`,
            )
            .join(" · ")}
          . This comparison presents numerical differences and observed changes only; any
          interpretation belongs to the analysis layer, not this table.
        </p>
      </CardContent>
    </Card>
  );
}

function renderDelta(v0: number, v1: number, pctScale: boolean): string {
  const d = v1 - v0;
  const scale = pctScale ? 100 : 1;
  const abs = Math.abs(d * scale);
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const rel = v0 !== 0 ? ` (${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs((d / v0) * 100).toFixed(1)}%)` : "";
  return `${sign}${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}${pctScale ? "pp" : ""}${rel}`;
}

function EndpointDistribution({ runs }: { runs: RunDoc[] }) {
  const allEndpoints = Array.from(
    new Set(runs.flatMap((r) => r.externalResult?.metrics?.per_endpoint?.map((e) => e.endpoint) ?? [])),
  );
  if (allEndpoints.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">single-endpoint runs — no weighted mix recorded</span>;
  }
  return (
    <div className="space-y-1.5">
      {allEndpoints.map((ep) => (
        <div key={ep} className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
          <span className="text-foreground">{ep}</span>
          {runs.map((r) => {
            const per = r.externalResult?.metrics?.per_endpoint ?? [];
            const entry = per.find((e) => e.endpoint === ep);
            const total = per.reduce((s, e) => s + e.total_requests, 0);
            const share = entry && total > 0 ? entry.total_requests / total : undefined;
            const requested =
              r.plan?.endpointWeights && r.plan.selectedEndpoints.length
                ? (r.plan.endpointWeights[ep] ?? 0) /
                  r.plan.selectedEndpoints.reduce((s, e) => s + (r.plan?.endpointWeights?.[e] ?? 0), 0)
                : undefined;
            return (
              <span key={r._id} className="text-muted-foreground">
                #{r._id.slice(-6)}: {entry ? `${entry.total_requests} req (${(share! * 100).toFixed(1)}%)` : "no requests"}{" "}
                {requested !== undefined ? (
                  <span className="text-muted-foreground/70">· requested {(requested * 100).toFixed(0)}%</span>
                ) : null}
              </span>
            );
          })}
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground/80">
        "requested" is the plan's endpoint weight; "observed" is k6's own per-endpoint request count —
        they are shown side by side and are not claimed to be identical.
      </p>
    </div>
  );
}
