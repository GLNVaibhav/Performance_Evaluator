import type { ReactNode } from "react";
import { AlertTriangle, HelpCircle, XOctagon } from "lucide-react";
import type { InterpretationResult } from "../../api/types";
import { JsonView } from "../common/JsonView";
import { TrafficBar } from "../common/TrafficBar";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[var(--color-muted)]">{label}</div>
      <div className="mt-0.5 text-[14px]">{value}</div>
    </div>
  );
}

export function InterpretationPanel({ result }: { result: InterpretationResult }) {
  if (result.status === "INTERPRETATION_FAILURE") {
    return (
      <PanelShell title="AI interpretation" accent="danger">
        <div className="flex items-start gap-3">
          <XOctagon size={18} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div>
            <div className="text-[14px] font-medium">AI interpretation service unavailable</div>
            <div className="mt-1 text-[13px] text-[var(--color-ink-dim)]">
              {result.reason ?? "The interpreter provider could not process this request."}
            </div>
            <div className="mt-2 text-[12px] text-[var(--color-muted)]">
              Check that <span className="font-mono">LLM_API_KEY</span> is configured on the backend.
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (result.status === "AMBIGUOUS") {
    return (
      <PanelShell title="AI interpretation" accent="warning">
        <div className="flex items-start gap-3">
          <HelpCircle size={18} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <div>
            <div className="text-[14px] font-medium">Multiple interpretations detected</div>
            <div className="mt-1 text-[13px] text-[var(--color-ink-dim)]">
              {result.reason ?? "The request doesn't map safely to a single test configuration."}
            </div>
            <div className="mt-2 text-[12px] text-[var(--color-muted)]">
              Try being specific about test type, load, duration, or which endpoints to target.
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (result.status === "INVALID") {
    return (
      <PanelShell title="AI interpretation" accent="danger">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div>
            <div className="text-[14px] font-medium">Request not supported</div>
            <div className="mt-1 text-[13px] text-[var(--color-ink-dim)]">{result.reason}</div>
          </div>
        </div>
      </PanelShell>
    );
  }

  const intent = result.intent!;
  const isIncomplete = result.status === "INCOMPLETE";
  const weights = intent.target_scope.endpoint_weights;
  const endpoints = intent.target_scope.endpoints ?? [];
  const total = weights ? Object.values(weights).reduce((a, b) => a + b, 0) : 0;

  return (
    <PanelShell title="AI interpretation" accent={isIncomplete ? "warning" : "success"}>
      {isIncomplete && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning-dim)]/40 px-3 py-2 text-[13px] text-[var(--color-warning)]">
          <HelpCircle size={14} />
          Agent needs additional information — proceeding to the deterministic compiler will surface exactly what's missing.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Objective" value={intent.objective ?? "—"} />
        <Field
          label="Concurrency"
          value={
            intent.load_profile.concurrent_users
              ? `${intent.load_profile.concurrent_users} virtual users`
              : intent.load_profile.peak_users
                ? `${intent.load_profile.peak_users} peak users`
                : "not specified"
          }
        />
        <Field label="Duration" value={intent.duration ?? "not specified"} />
        <Field label="Test type" value={intent.test_type ?? "not specified"} />
      </div>

      {endpoints.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] text-[var(--color-muted)]">Target endpoints</div>
          <div className="flex flex-wrap gap-1.5">
            {endpoints.map((e) => (
              <span key={e} className="rounded border border-[var(--color-hairline)] px-2 py-1 font-mono text-[12px]">
                {e}
              </span>
            ))}
          </div>
        </div>
      )}

      {weights && total > 0 && (
        <div className="mt-4 space-y-1.5">
          <div className="mb-2 text-[11px] text-[var(--color-muted)]">Traffic distribution</div>
          {Object.entries(weights).map(([ep, w]) => (
            <TrafficBar key={ep} label={ep} percent={Math.round((w / total) * 100)} />
          ))}
        </div>
      )}

      {(intent.success_criteria.p95_latency_ms || intent.success_criteria.error_rate != null) && (
        <div className="mt-4 flex gap-6">
          {intent.success_criteria.p95_latency_ms && (
            <Field label="Success criteria" value={`P95 < ${intent.success_criteria.p95_latency_ms}ms`} />
          )}
        </div>
      )}

      <JsonView data={intent} label="View raw UniversalPerformanceIntent" />
    </PanelShell>
  );
}

export function PanelShell({
  title,
  accent,
  children,
}: {
  title: string;
  accent: "signal" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const border = {
    signal: "border-l-[var(--color-signal)]",
    success: "border-l-[var(--color-success)]",
    warning: "border-l-[var(--color-warning)]",
    danger: "border-l-[var(--color-danger)]",
  }[accent];

  return (
    <div className={`rounded-lg border border-[var(--color-hairline)] border-l-2 ${border} bg-[var(--color-panel)] p-5`}>
      <div className="mb-4 text-[13px] font-medium text-[var(--color-ink-dim)]">{title}</div>
      {children}
    </div>
  );
}
