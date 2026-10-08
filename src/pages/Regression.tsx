import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * PERFORMANCE REGRESSION INTELLIGENCE (Phase 10) — /app/regression.
 *
 * Three clearly separated layers:
 *   MEASURED               — the two immutable runs and their recorded values
 *   DETERMINISTIC ANALYSIS — the reproducible regression object (deltas +
 *                            policy classifications), computed by the pure
 *                            engine from the stored runs
 *   AI INTERPRETATION      — validated, classification-tagged restatement
 *
 * No overall score, no good/bad/better/worse verdict anywhere.
 */

type Id = string;

type RunOption = {
  _id: Id;
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
    errorRate: number;
    p50: number;
    p95: number;
    p99: number;
    maxRps: number;
    latencyAvgMs?: number;
    latencyMaxMs?: number;
  };
};

type MetricDelta = {
  baseline: number | null;
  candidate: number | null;
  absoluteDelta: number | null;
  percentageDelta: number | null;
  baselineSource: string;
  candidateSource: string;
};

type EndpointComparison = {
  endpoint: string;
  requests: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  p50: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  p95: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  p99: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  average: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  max: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  rps: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  errorRate: { baseline: number | null; candidate: number | null; absoluteDelta: number | null; percentageDelta: number | null };
  statusDistributionChanges: string[];
};

type DeterministicObject = {
  baselineRunId: Id;
  candidateRunId: Id;
  compatibility: "COMPATIBLE" | "INCOMPATIBLE";
  compatibilityReasons: string[];
  loadSensitivityOnly: boolean;
  policyVersion: string;
  policy: { latencyRegressionThresholdPct: number; rpsDegradationThresholdPct: number; errorRateRegressionThresholdPp: number };
  metrics: {
    p50: MetricDelta;
    p95: MetricDelta;
    p99: MetricDelta;
    average: MetricDelta;
    max: MetricDelta;
    rps: MetricDelta;
    errorRate: MetricDelta;
    totalRequests: MetricDelta;
  };
  endpointResults: EndpointComparison[];
  statusDistributionChanges: string[];
  classifications: string[];
  breaches: string[];
  status: string;
  inconclusive: { reasons: string[]; detail: string[] } | null;
  baselineSummary: { runId: string; status: string; executionMode: string; totalRequests: number | null };
  candidateSummary: { runId: string; status: string; executionMode: string; totalRequests: number | null };
};

type RegressionDoc = {
  _id: Id;
  baselineRunId: Id;
  candidateRunId: Id;
  version: number;
  policyVersion: string;
  createdAt: number;
  deterministic: DeterministicObject;
  aiAnalyzerKind?: string;
  aiGeneratedAt?: number;
};

type RegressionAiDoc = {
  _id: Id;
  version: number;
  analyzerKind: string;
  model?: string;
  promptVersion: string;
  generatedAt: number;
  analysis: {
    summary: string;
    whatChanged: { statement: string; classification: string; evidence: string[] }[];
    endpointObservations: { endpoint: string; statement: string; classification: string; evidence: string[] }[];
    limitations: string[];
    confidenceNotes: string[];
    rejected: { reason: string; excerpt: string }[];
  };
};

const STATUS_STYLE: Record<string, string> = {
  NO_REGRESSION_DETECTED: "border-emerald-500/50 text-emerald-400",
  LATENCY_REGRESSION: "border-amber-500/50 text-amber-400",
  THROUGHPUT_REGRESSION: "border-sky-500/50 text-sky-400",
  ERROR_RATE_REGRESSION: "border-red-500/50 text-red-400",
  MULTIPLE_REGRESSIONS: "border-red-500/60 text-red-300",
  INCONCLUSIVE: "border-slate-500/50 text-slate-300",
};

const CLASS_STYLE: Record<string, string> = {
  OBSERVED: "border-emerald-500/40 text-emerald-400",
  INFERRED: "border-amber-500/40 text-amber-400",
  UNKNOWN: "border-slate-500/40 text-slate-300",
};

function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function signed(n: number | null, unit = ""): string {
  if (n === null) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  return `${sign}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[11px] tracking-wide",
        STATUS_STYLE[status] ?? "border-border text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function ClassBadge({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide",
        CLASS_STYLE[value] ?? "border-border text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

function LayerTag({ kind, className }: { kind: "MEASURED" | "DETERMINISTIC ANALYSIS" | "AI INTERPRETATION"; className?: string }) {
  const styles = {
    MEASURED: "border-sky-500/40 text-sky-300 bg-sky-500/5",
    "DETERMINISTIC ANALYSIS": "border-emerald-500/40 text-emerald-300 bg-emerald-500/5",
    "AI INTERPRETATION": "border-violet-500/40 text-violet-300 bg-violet-500/5",
  } as const;
  return (
    <span className={cn("inline-flex rounded border px-2 py-0.5 font-mono text-[10px] tracking-widest", styles[kind], className)}>
      {kind}
    </span>
  );
}

export default function Regression() {
  const runs = (useQuery(api.queries.listRuns) ?? []) as unknown as RunOption[];
  const history = (useQuery(api.regressionDb.listMyRegressionAnalyses) ?? []) as unknown as RegressionDoc[];
  const create = useMutation(api.regressionDb.createRegressionAnalysis);
  const analyze = useAction(api.regressionEntries.analyzeMyRegression);

  const [baselineId, setBaselineId] = useState<Id | null>(null);
  const [candidateId, setCandidateId] = useState<Id | null>(null);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const selected = useMemo(
    () => (selectedId ? (history.find((h) => h._id === selectedId) ?? null) : history[0] ?? null),
    [selectedId, history],
  );

  const aiAnalysis = useQuery(
    api.regressionQueries.latestAiForRegression,
    selected ? ({ regressionId: selected._id } as never) : "skip",
  ) as RegressionAiDoc | null | undefined;

  async function runComparison() {
    if (!baselineId || !candidateId) return;
    setBusy(true);
    setError(null);
    try {
      const { regressionId } = (await create({
        baselineRunId: baselineId,
        candidateRunId: candidateId,
      } as never)) as unknown as { regressionId: Id; version: number };
      setSelectedId(regressionId as Id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runAi() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await analyze({ regressionId: selected._id } as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Regression intelligence</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deterministic comparison of two compatible LIVE_K6 runs: factual deltas, policy classifications, and a
          downstream AI interpretation. No score, no quality verdict.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-300">{error}</div>
      )}

      {/* --- selection --- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New comparison</CardTitle>
          <CardDescription>
            {eligible.length} eligible completed LIVE_K6 run{eligible.length === 1 ? "" : "s"} in your history.
            Compatibility is checked before any delta is computed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <RunPicker
              label="BASELINE"
              tone="sky"
              runs={eligible}
              value={baselineId}
              onSelect={setBaselineId}
              exclude={candidateId}
            />
            <RunPicker
              label="CANDIDATE"
              tone="amber"
              runs={eligible}
              value={candidateId}
              onSelect={setCandidateId}
              exclude={baselineId}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!baselineId || !candidateId || busy || baselineId === candidateId} onClick={() => void runComparison()}>
              {busy ? "computing…" : "Run deterministic comparison"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              The engine reads the two immutable runs and stores a regression analysis — the runs are never modified.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* --- history --- */}
      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Regression history</CardTitle>
            <CardDescription>Stored independently from the runs — append-only, immutable once created.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border/50">
              {history.map((h) => (
                <button
                  key={h._id}
                  onClick={() => setSelectedId(h._id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 py-2.5 px-2 -mx-2 rounded-md text-left transition-colors",
                    selected?._id === h._id ? "bg-primary/10" : "hover:bg-secondary/40",
                  )}
                >
                  <div className="min-w-0 font-mono text-xs">
                    <span className="text-primary">#{h.baselineRunId.slice(-6)}</span>
                    <span className="text-muted-foreground"> → </span>
                    <span className="text-amber-300">#{h.candidateRunId.slice(-6)}</span>
                    <span className="text-muted-foreground"> · v{h.version} · {h.policyVersion}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={h.deterministic?.status ?? "INCONCLUSIVE"} />
                    {h.aiAnalyzerKind && (
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {h.aiAnalyzerKind === "llm" ? "AI" : "deterministic AI fallback"}
                      </Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* --- detail --- */}
      {selected && <RegressionDetail doc={selected} ai={aiAnalysis ?? null} onGenerateAi={() => void runAi()} busy={busy} />}
    </div>
  );
}

function RunPicker({
  label,
  tone,
  runs,
  value,
  onSelect,
  exclude,
}: {
  label: string;
  tone: "sky" | "amber";
  runs: RunOption[];
  value: Id | null;
  onSelect: (id: Id | null) => void;
  exclude: Id | null;
}) {
  return (
    <div className="space-y-2">
      <div className={cn("text-[10px] font-mono uppercase tracking-widest", tone === "sky" ? "text-sky-300" : "text-amber-300")}>
        {label}
      </div>
      <select
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        value={value ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">— select a run —</option>
        {runs
          .filter((r) => r._id !== exclude)
          .map((r) => (
            <option key={r._id} value={r._id}>
              #{r._id.slice(-6)} · {r.plan?.objectiveType} {r.plan?.targetVus}VU{" "}
              {r.plan?.duration ?? `${r.plan?.rampDuration}+${r.plan?.holdDuration}`} · {r.plan?.selectedEndpoints?.join(",")} ·
              p95 {fmt(r.metrics?.p95, 1)}ms
            </option>
          ))}
      </select>
    </div>
  );
}

function RegressionDetail({
  doc,
  ai,
  onGenerateAi,
  busy,
}: {
  doc: RegressionDoc;
  ai: RegressionAiDoc | null;
  onGenerateAi: () => void;
  busy: boolean;
}) {
  const d = doc.deterministic;
  return (
    <div className="space-y-6">
      {/* ================= MEASURED ================= */}
      <Card className="border-sky-500/30">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <LayerTag kind="MEASURED" />
            <span className="text-sm text-muted-foreground">the two immutable runs</span>
          </CardTitle>
          <CardDescription>
            Recorded measurements only — verbatim k6 → FastAPI → Convex, never recomputed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <RunSummaryCard role="BASELINE" tone="sky" summary={d.baselineSummary} runId={d.baselineRunId} />
            <RunSummaryCard role="CANDIDATE" tone="amber" summary={d.candidateSummary} runId={d.candidateRunId} />
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-card/60 p-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Compatibility</span>
            <Badge variant={d.compatibility === "COMPATIBLE" ? "success" : "destructive"} className="font-mono">
              {d.compatibility}
            </Badge>
            {d.loadSensitivityOnly && (
              <Badge variant="secondary" className="font-mono text-[10px] border-amber-500/40 text-amber-300">
                load-sensitivity comparison (VU mismatch ≠ regression)
              </Badge>
            )}
            {d.compatibilityReasons.length > 0 ? (
              <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {d.compatibilityReasons.map((r, i) => (
                  <li key={i}>✗ {r}</li>
                ))}
              </ul>
            ) : (
              <span className="text-[11px] text-muted-foreground">target · mode · objective · test type · endpoints · weights · VUs · duration · thresholds all match</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ================= DETERMINISTIC ANALYSIS ================= */}
      <Card className="border-emerald-500/30">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <LayerTag kind="DETERMINISTIC ANALYSIS" />
            <StatusBadge status={d.status} />
            <span className="font-mono text-[10px] text-muted-foreground">{d.policyVersion}</span>
          </CardTitle>
          <CardDescription>
            Reproducible from the stored runs + policy. Deltas are exact stored-source values; classification follows
            the documented thresholds (latency +{d.policy.latencyRegressionThresholdPct}%, RPS −
            {d.policy.rpsDegradationThresholdPct}%, error rate +{d.policy.errorRateRegressionThresholdPp}pp).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {d.inconclusive && (
            <div className="rounded-md border border-slate-500/40 bg-slate-500/5 p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-300">Inconclusive — no regression verdict forced</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {d.inconclusive.reasons.map((r, i) => (
                  <li key={i}>▸ {r}</li>
                ))}
                {d.inconclusive.detail.map((r, i) => (
                  <li key={`d${i}`} className="text-muted-foreground/70">· {r}</li>
                ))}
              </ul>
            </div>
          )}

          {d.breaches.length > 0 && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
              <div className="text-[10px] uppercase tracking-wider text-red-400">Policy threshold breaches (factual)</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {d.breaches.map((b, i) => (
                  <li key={i}>▸ {b}</li>
                ))}
              </ul>
            </div>
          )}

          {d.status !== "INCONCLUSIVE" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Metric</th>
                    <th className="py-2 px-3 font-medium">Baseline</th>
                    <th className="py-2 px-3 font-medium">Candidate</th>
                    <th className="py-2 px-3 font-medium">Δ</th>
                    <th className="py-2 px-3 font-medium">Δ%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  <MetricRow label="p50 (ms)" delta={d.metrics.p50} />
                  <MetricRow label="p95 (ms)" delta={d.metrics.p95} />
                  <MetricRow label="p99 (ms)" delta={d.metrics.p99} />
                  <MetricRow label="Average (ms)" delta={d.metrics.average} />
                  <MetricRow label="Max (ms)" delta={d.metrics.max} />
                  <MetricRow label="RPS" delta={d.metrics.rps} />
                  <MetricRow label="Error rate" delta={d.metrics.errorRate} pct />
                  <MetricRow label="Total requests" delta={d.metrics.totalRequests} dp={0} />
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground/80">
                Sources — baseline: {d.metrics.p95.baselineSource}; candidate: {d.metrics.p95.candidateSource}. A missing
                percentage means a zero baseline (no meaningful ratio); the absolute delta stays factual.
              </p>
            </div>
          )}

          {d.endpointResults.length > 0 && (
            <div className="space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Endpoint comparison</div>
              {d.endpointResults.map((row) => (
                <div key={row.endpoint} className="rounded-md border border-border/60 bg-background/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-primary">{row.endpoint}</span>
                    <div className="flex flex-wrap gap-2 font-mono text-[11px]">
                      <span className="text-muted-foreground">p95 {fmt(row.p95.baseline)}→{fmt(row.p95.candidate)}ms</span>
                      <span className={row.p95.absoluteDelta !== null && row.p95.absoluteDelta > 0 ? "text-amber-400" : "text-muted-foreground"}>
                        Δ {signed(row.p95.absoluteDelta)}ms
                      </span>
                      <span className="text-muted-foreground">
                        Δ% {signed(row.p95.percentageDelta)}% · err {fmt(row.errorRate.baseline !== null ? row.errorRate.baseline * 100 : null, 2)}%→
                        {fmt(row.errorRate.candidate !== null ? row.errorRate.candidate * 100 : null, 2)}% · req Δ {signed(row.requests.absoluteDelta, "")}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 grid gap-x-6 gap-y-0.5 font-mono text-[10px] text-muted-foreground/80 md:grid-cols-3">
                    <span>p50 {signed(row.p50.absoluteDelta)}ms · p99 {signed(row.p99.absoluteDelta)}ms</span>
                    <span>avg {signed(row.average.absoluteDelta)}ms · max {signed(row.max.absoluteDelta)}ms</span>
                    <span>rps {signed(row.rps.absoluteDelta)}</span>
                  </div>
                  {row.statusDistributionChanges.length > 0 && (
                    <div className="mt-1.5 space-y-0.5 font-mono text-[10px] text-amber-300/90">
                      {row.statusDistributionChanges.map((c, i) => (
                        <div key={i}>▸ {c}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {d.statusDistributionChanges.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-[10px] uppercase tracking-wider text-amber-300">Status-code distribution changes</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {d.statusDistributionChanges.map((c, i) => (
                  <li key={i}>▸ {c}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                Factual distribution differences only — the deterministic layer never states a cause.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ================= AI INTERPRETATION ================= */}
      <Card className="border-violet-500/30">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <LayerTag kind="AI INTERPRETATION" />
            {ai && (
              <>
                <Badge variant="secondary" className="font-mono text-[10px]">
                  v{ai.version}
                </Badge>
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {ai.analyzerKind === "llm" ? `AI analyst · ${ai.model ?? "model"}` : "deterministic fallback"}
                </Badge>
              </>
            )}
          </CardTitle>
          <CardDescription>
            Interpretation of the deterministic regression evidence — advisory only. The AI cannot modify the metrics,
            classifications, or compatibility verdict above; rejected claims are listed with reasons.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!ai && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card p-3">
              <p className="text-xs text-muted-foreground">
                No interpretation generated yet. The analyst reads the deterministic object plus both runs' evidence and
                returns a validated restatement of what changed.
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={onGenerateAi}>
                {busy ? "analyzing…" : "Generate AI interpretation"}
              </Button>
            </div>
          )}
          {ai && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[10px] text-muted-foreground">
                  prompt {ai.promptVersion} · generated {new Date(ai.generatedAt).toLocaleString()}
                </p>
                <Button size="sm" variant="outline" disabled={busy} onClick={onGenerateAi}>
                  {busy ? "analyzing…" : "Regenerate (new version)"}
                </Button>
              </div>
              <p className="text-sm leading-relaxed">{ai.analysis.summary}</p>
              {ai.analysis.whatChanged?.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">What changed</div>
                  {ai.analysis.whatChanged.map((o, i) => (
                    <div key={i} className="rounded-md border border-border/60 bg-background/60 p-2.5">
                      <div className="flex items-start gap-2">
                        <ClassBadge value={o.classification} />
                        <p className="text-sm leading-relaxed text-muted-foreground">{o.statement}</p>
                      </div>
                      {o.evidence.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground/60">
                          {o.evidence.map((e, j) => (
                            <span key={j} className="rounded bg-muted/40 px-1 py-0.5">{e}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {ai.analysis.endpointObservations?.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Endpoint observations</div>
                  {ai.analysis.endpointObservations.map((o, i) => (
                    <div key={i} className="rounded-md border border-border/60 bg-background/60 p-2.5">
                      <div className="flex items-start gap-2">
                        <ClassBadge value={o.classification} />
                        <div>
                          <span className="font-mono text-xs text-foreground/80">{o.endpoint}</span>
                          <p className="text-sm leading-relaxed text-muted-foreground">{o.statement}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {ai.analysis.limitations?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Limitations</div>
                  <ul className="mt-1 space-y-1">
                    {ai.analysis.limitations.map((l, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex gap-2">
                        <span className="text-violet-400/70 font-mono">▸</span> {l}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {ai.analysis.rejected?.length > 0 && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-red-400">
                    Rejected model claims (deterministic validation)
                  </div>
                  <ul className="mt-1 space-y-1">
                    {ai.analysis.rejected.map((r, i) => (
                      <li key={i} className="text-xs text-muted-foreground font-mono">
                        ✗ [{r.reason}] “{r.excerpt}”
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RunSummaryCard({
  role,
  tone,
  summary,
  runId,
}: {
  role: string;
  tone: "sky" | "amber";
  summary: { runId: string; status: string; executionMode: string; totalRequests: number | null };
  runId: Id;
}) {
  return (
    <div className={cn("rounded-md border p-3", tone === "sky" ? "border-sky-500/30 bg-sky-500/5" : "border-amber-500/30 bg-amber-500/5")}>
      <div className="flex items-center justify-between">
        <span className={cn("font-mono text-[10px] uppercase tracking-widest", tone === "sky" ? "text-sky-300" : "text-amber-300")}>
          {role}
        </span>
        <Link to={`/app/runs/${runId}`} className="font-mono text-xs text-primary hover:underline">
          #{runId.slice(-6)}
        </Link>
      </div>
      <div className="mt-1.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">
        <div>status: {summary.status} · mode: {summary.executionMode}</div>
        <div>total requests: {fmt(summary.totalRequests, 0)}</div>
      </div>
    </div>
  );
}

function MetricRow({ label, delta, pct, dp = 2 }: { label: string; delta: MetricDelta; pct?: boolean; dp?: number }) {
  const scale = pct ? 100 : 1;
  const unit = pct ? "pp" : "";
  const worsening =
    (delta.absoluteDelta !== null && delta.absoluteDelta > 0 && (label.includes("p5") || label.includes("Average") || label.includes("Max") || label === "Error rate")) ||
    (label === "RPS" && delta.absoluteDelta !== null && delta.absoluteDelta < 0);
  return (
    <tr>
      <td className="py-2 pr-4 text-muted-foreground">{label}</td>
      <td className="py-2 px-3 font-mono">{pct ? fmt(delta.baseline !== null ? delta.baseline * 100 : null) + "%" : fmt(delta.baseline, dp)}</td>
      <td className="py-2 px-3 font-mono">{pct ? fmt(delta.candidate !== null ? delta.candidate * 100 : null) + "%" : fmt(delta.candidate, dp)}</td>
      <td className={cn("py-2 px-3 font-mono", worsening ? "text-amber-400" : "text-muted-foreground")}>
        {pct ? signed(delta.absoluteDelta !== null ? delta.absoluteDelta * 100 : null, unit) : signed(delta.absoluteDelta, unit)}
      </td>
      <td className="py-2 px-3 font-mono text-muted-foreground">{signed(delta.percentageDelta, "%")}</td>
    </tr>
  );
}
