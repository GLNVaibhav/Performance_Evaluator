import { AlertOctagon, Check, HelpCircle } from "lucide-react";
import type { IntentCompilationResponse } from "../../api/types";
import { JsonView } from "../common/JsonView";
import { PanelShell } from "../intent/InterpretationPanel";

const CHECKS = [
  "Test type validated",
  "Load profile validated",
  "Endpoint structure validated",
  "Workload constraints verified",
  "Threshold configuration resolved",
];

export function CompilationPanel({ result }: { result: IntentCompilationResponse }) {
  if (result.status === "NEEDS_CLARIFICATION") {
    return (
      <PanelShell title="Deterministic compiler" accent="warning">
        <div className="flex items-start gap-3">
          <HelpCircle size={18} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <div className="flex-1">
            <div className="text-[14px] font-medium">Additional information required</div>
            <div className="mt-3 space-y-2">
              {result.clarifications_needed.map((c) => (
                <div
                  key={c.field}
                  className="rounded-md border border-[var(--color-warning)]/25 bg-[var(--color-warning-dim)]/30 px-3 py-2"
                >
                  <div className="font-mono text-[11px] text-[var(--color-warning)]">{c.field}</div>
                  <div className="mt-0.5 text-[13px] text-[var(--color-ink-dim)]">{c.question}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (result.status === "INVALID") {
    return (
      <PanelShell title="Deterministic compiler" accent="danger">
        <div className="flex items-start gap-3">
          <AlertOctagon size={18} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div>
            <div className="text-[14px] font-medium">Intent rejected</div>
            <div className="mt-1 font-mono text-[11px] text-[var(--color-danger)]">{result.rejection_code}</div>
            <div className="mt-1 text-[13px] text-[var(--color-ink-dim)]">{result.rejection_reason}</div>
          </div>
        </div>
      </PanelShell>
    );
  }

  const plan = result.test_plan!;

  return (
    <PanelShell title="Deterministic compiler" accent="success">
      <div className="mb-4 space-y-1.5">
        {CHECKS.map((c) => (
          <div key={c} className="flex items-center gap-2 text-[13px] text-[var(--color-ink-dim)]">
            <Check size={13} className="text-[var(--color-success)]" />
            {c}
          </div>
        ))}
      </div>

      <div className="rounded-md border border-[var(--color-hairline)] bg-black/20 p-4">
        <div className="mb-2 text-[11px] text-[var(--color-muted)]">Executable TestPlan</div>
        <div className="grid grid-cols-4 gap-3 font-mono text-[13px]">
          <div>
            <div className="text-[10px] text-[var(--color-muted)]">objective_type</div>
            {plan.objective_type}
          </div>
          <div>
            <div className="text-[10px] text-[var(--color-muted)]">target_vus</div>
            {plan.target_vus}
          </div>
          <div>
            <div className="text-[10px] text-[var(--color-muted)]">duration</div>
            {plan.duration ?? `${plan.ramp_duration} → ${plan.hold_duration}`}
          </div>
          <div>
            <div className="text-[10px] text-[var(--color-muted)]">payload_strategy</div>
            {plan.payload_strategy ?? "normal"}
          </div>
        </div>
      </div>

      {plan.assumptions.length > 0 && (
        <div className="mt-3 text-[12px] text-[var(--color-ink-dim)]">
          <span className="text-[var(--color-muted)]">Assumptions applied: </span>
          {plan.assumptions.join(", ")}
        </div>
      )}

      <JsonView data={plan} label="View raw TestPlan" />
    </PanelShell>
  );
}
