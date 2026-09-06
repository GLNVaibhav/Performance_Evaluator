import { useState } from "react";
import { CheckCircle2, Sparkles, XCircle } from "lucide-react";
import type { AIAnalysis, TestResult } from "../../api/types";
import { runsApi } from "../../api/runs";
import { ApiError } from "../../api/client";
import { JsonView } from "../common/JsonView";

function MetricCard({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-4">
      <div className="text-[11px] text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-[var(--color-ink-dim)]">{unit}</span>}
      </div>
    </div>
  );
}

// Pre-existing deterministic insight (kept as-is -- still useful, low-cost,
// purely frontend-side heuristic over the raw per-endpoint metrics; does
// NOT overlap with the new Statistics/failure-localization/AI sections
// below, which are the backend's own structured evidence rather than a
// client-side re-sort of it).
function buildInsight(result: TestResult): string | null {
  const rows = result.metrics.per_endpoint;
  if (rows.length < 2) return null;

  const slowest = [...rows].sort((a, b) => b.p95_ms - a.p95_ms)[0];
  const busiest = [...rows].sort((a, b) => b.total_requests - a.total_requests)[0];
  const errored = [...rows].sort((a, b) => b.error_rate - a.error_rate)[0];

  if (errored.error_rate > 0) {
    return `${errored.endpoint} showed the highest error rate (${(errored.error_rate * 100).toFixed(1)}%) of all tested endpoints.`;
  }
  if (slowest.endpoint !== busiest.endpoint) {
    return `${slowest.endpoint} had the highest p95 latency (${slowest.p95_ms.toFixed(0)}ms) despite ${busiest.endpoint} receiving the most traffic (${busiest.total_requests} requests).`;
  }
  return `${slowest.endpoint} exhibited the highest latency relative to the other tested endpoints (p95 ${slowest.p95_ms.toFixed(0)}ms).`;
}

// ms formatter for an optional (possibly absent) percentile -- Session 5's
// p75/p90 are genuinely absent (not zero) for a result predating that
// collection mechanism; never render a guessed number.
function fmtMs(value?: number | null): string {
  return value == null ? "N/A" : `${value.toFixed(1)}ms`;
}

function LatencyDetail({ result }: { result: TestResult }) {
  const lat = result.statistics?.latency;
  if (!lat) return null;
  return (
    <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-5">
      <div className="mb-3 text-[13px] font-medium text-[var(--color-ink-dim)]">Latency detail</div>
      <div className="grid grid-cols-7 gap-3 font-mono text-[13px]">
        {(["p50_ms", "p75_ms", "p90_ms", "p95_ms", "p99_ms", "average_ms", "max_ms"] as const).map((key) => (
          <div key={key}>
            <div className="text-[10px] text-[var(--color-muted)]">{key.replace("_ms", "").replace("average", "avg")}</div>
            {fmtMs(lat[key])}
          </div>
        ))}
      </div>
      {lat.tail_latency_ratio != null && (
        <div className="mt-3 text-[12px] text-[var(--color-ink-dim)]">
          p99/p50 ratio: <span className="font-mono">{lat.tail_latency_ratio.toFixed(2)}x</span>
        </div>
      )}
    </div>
  );
}

function StatusCodes({ result }: { result: TestResult }) {
  const sc = result.statistics?.status_codes;
  const counts = sc?.counts ?? {};
  const codes = Object.keys(counts);
  return (
    <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-5">
      <div className="mb-3 text-[13px] font-medium text-[var(--color-ink-dim)]">HTTP status codes</div>
      {codes.length === 0 ? (
        <div className="text-[13px] text-[var(--color-muted)]">No status-code evidence available</div>
      ) : (
        <div className="flex flex-wrap gap-3 font-mono text-[13px]">
          {/* Deterministic display order; never assumes a fixed set of codes. */}
          {codes.sort().map((code) => (
            <div key={code} className="rounded-md border border-[var(--color-hairline)] px-3 py-1.5">
              {code}: {counts[code].toLocaleString()}
              {sc?.percentages[code] != null && (
                <span className="ml-1 text-[var(--color-ink-dim)]">({sc.percentages[code].toFixed(1)}%)</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FailureLocalizationPanel({ result }: { result: TestResult }) {
  const fl = result.failure_localization;
  if (!fl || fl.violations.length === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger-dim)]/10 p-5">
      <div className="mb-3 text-[13px] font-medium text-[var(--color-danger)]">Failure localization</div>
      {fl.primary_failure && (
        <div className="mb-3 font-mono text-[13px]">
          <span className="text-[var(--color-ink-dim)]">Primary: </span>
          {fl.primary_failure.scope} {fl.primary_failure.metric} {fl.primary_failure.observed} &gt;{" "}
          {fl.primary_failure.threshold}
        </div>
      )}
      <div className="space-y-1 font-mono text-[12px] text-[var(--color-ink-dim)]">
        {fl.violations.map((v, i) => (
          <div key={i}>
            {v.scope} {v.metric}: {v.observed} &gt; {v.threshold}
          </div>
        ))}
      </div>
      {fl.load_context && (
        <div className="mt-3 text-[11px] text-[var(--color-muted)]">
          Under load: {fl.load_context.target_vus} VUs, {fl.load_context.duration}
        </div>
      )}
    </div>
  );
}

function AIAnalysisPanel({ runId }: { runId: string }) {
  // Deliberately no "existing" prop: the backend never returns AIAnalysis
  // as part of TestResult (see api/types.ts's TestResult docstring) --
  // analysis only ever exists in this component's own local state, set by
  // an explicit runsApi.analyze() call the user triggers below.
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "unavailable" | "error">("idle");
  const [reason, setReason] = useState<string | null>(null);

  async function requestAnalysis() {
    setState("loading");
    try {
      const resp = await runsApi.analyze(runId);
      if (resp.available && resp.analysis) {
        setAnalysis(resp.analysis);
        setState("idle");
      } else {
        setState("unavailable");
        setReason(resp.reason ?? "AI analysis is not available for this run.");
      }
    } catch (e) {
      setState("error");
      setReason(e instanceof ApiError ? String(e.detail) : "network error contacting backend");
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-ink-dim)]">
          <Sparkles size={14} className="text-[var(--color-signal)]" />
          AI analysis
        </div>
        {!analysis && (
          <button
            onClick={requestAnalysis}
            disabled={state === "loading"}
            className="rounded-md border border-[var(--color-hairline)] px-3 py-1.5 text-[12px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            {state === "loading" ? "Analyzing…" : "Get AI analysis"}
          </button>
        )}
      </div>

      {/* Deterministic result is complete with or without this section --
          "unavailable" is an ordinary, expected outcome, not an error
          state for the run itself. */}
      {(state === "unavailable" || state === "error") && (
        <div className="text-[13px] text-[var(--color-muted)]">{reason}</div>
      )}

      {analysis && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-[11px] uppercase ${
                analysis.severity === "high"
                  ? "bg-[var(--color-danger-dim)] text-[var(--color-danger)]"
                  : analysis.severity === "medium"
                    ? "bg-[var(--color-warning-dim)] text-[var(--color-warning)]"
                    : "bg-[var(--color-success-dim)] text-[var(--color-success)]"
              }`}
            >
              {analysis.severity}
            </span>
            <span className="text-[11px] text-[var(--color-muted)]">confidence: {analysis.confidence}</span>
          </div>
          <div className="text-[13px] text-[var(--color-ink)]">{analysis.summary}</div>
          {analysis.findings.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--color-ink-dim)]">
              {analysis.findings.map((f, i) => (
                <li key={i}>• {f.statement}</li>
              ))}
            </ul>
          )}
          {analysis.limitations.length > 0 && (
            <div className="mt-2 text-[11px] text-[var(--color-muted)]">
              {analysis.limitations.join(" ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsPanel({ result }: { result: TestResult }) {
  const pass = result.threshold_status === "PASS";
  const insight = buildInsight(result);

  return (
    <div className="space-y-6">
      <div
        className={`flex items-center gap-3 rounded-lg border p-5 ${
          pass ? "border-[var(--color-success)]/30 bg-[var(--color-success-dim)]/20" : "border-[var(--color-danger)]/30 bg-[var(--color-danger-dim)]/20"
        }`}
      >
        {pass ? (
          <CheckCircle2 size={22} className="text-[var(--color-success)]" />
        ) : (
          <XCircle size={22} className="text-[var(--color-danger)]" />
        )}
        <div>
          <div className="text-[13px] text-[var(--color-ink-dim)]">Performance evaluation complete</div>
          <div className={`text-xl font-semibold ${pass ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
            {pass ? "PASS" : "Threshold breach"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <MetricCard label="P95 latency" value={result.metrics.p95_ms.toFixed(1)} unit="ms" />
        <MetricCard label="Error rate" value={(result.metrics.error_rate * 100).toFixed(2)} unit="%" />
        <MetricCard label="Total requests" value={result.metrics.total_requests.toLocaleString()} />
        <MetricCard label="Throughput" value={result.metrics.rps.toFixed(1)} unit="req/s" />
        <MetricCard label="Duration" value={result.metrics.duration_s.toFixed(0)} unit="s" />
      </div>

      <LatencyDetail result={result} />
      <StatusCodes result={result} />

      {result.metrics.per_endpoint.length > 0 && (
        <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-5">
          <div className="mb-4 text-[13px] font-medium text-[var(--color-ink-dim)]">Endpoint intelligence</div>
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-hairline)] text-[11px] text-[var(--color-muted)]">
                <th className="pb-2 font-normal">Endpoint</th>
                <th className="pb-2 font-normal">Traffic</th>
                <th className="pb-2 font-normal">P95</th>
                <th className="pb-2 font-normal">Error rate</th>
                <th className="pb-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...result.metrics.per_endpoint]
                .sort((a, b) => b.total_requests - a.total_requests)
                .map((row) => {
                  const healthy = row.error_rate === 0 && row.p95_ms < result.metrics.p95_ms * 1.5;
                  return (
                    <tr key={row.endpoint} className="border-b border-[var(--color-hairline)]/50">
                      <td className="py-2.5 font-mono">{row.endpoint}</td>
                      <td className="py-2.5 text-[var(--color-ink-dim)]">{row.total_requests} req</td>
                      <td className="py-2.5 font-mono">{row.p95_ms.toFixed(1)}ms</td>
                      <td className="py-2.5 font-mono">{(row.error_rate * 100).toFixed(1)}%</td>
                      <td className="py-2.5">
                        <span
                          className={`rounded px-2 py-0.5 text-[11px] ${
                            healthy
                              ? "bg-[var(--color-success-dim)] text-[var(--color-success)]"
                              : "bg-[var(--color-warning-dim)] text-[var(--color-warning)]"
                          }`}
                        >
                          {healthy ? "Healthy" : "Watch"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {result.metrics.per_endpoint.length === 0 && (
        <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-5 text-[13px] text-[var(--color-muted)]">
          No endpoint evidence available
        </div>
      )}

      {insight && (
        <div className="rounded-lg border border-[var(--color-signal)]/25 bg-[var(--color-signal-dim)]/15 p-4">
          <div className="mb-1 text-[11px] text-[var(--color-signal)]">Performance insight</div>
          <div className="text-[13px] text-[var(--color-ink-dim)]">{insight}</div>
        </div>
      )}

      <FailureLocalizationPanel result={result} />
      <AIAnalysisPanel runId={result.run_id} />

      <JsonView data={result} label="View raw TestResult" />
    </div>
  );
}
