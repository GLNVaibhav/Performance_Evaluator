import { useEffect, useState } from "react";
import type { RunState, TestPlan } from "../../api/types";
import { StatusDot } from "../common/StatusDot";

const STAGES: { state: RunState; label: string }[] = [
  { state: "QUEUED", label: "Initializing" },
  { state: "RUNNING", label: "Executing k6 · collecting telemetry" },
];

export function ExecutionPanel({
  runId,
  runState,
  plan,
  targetBaseUrl,
}: {
  runId: string;
  runState: RunState;
  plan: TestPlan;
  targetBaseUrl: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-panel)] p-6">
      <div className="flex items-center gap-2.5">
        <StatusDot tone="signal" pulse />
        <div className="text-[15px] font-semibold">Running performance evaluation</div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-4 font-mono text-[13px]">
        <div>
          <div className="text-[10px] text-[var(--color-muted)]">run id</div>
          {runId.slice(0, 12)}…
        </div>
        <div>
          <div className="text-[10px] text-[var(--color-muted)]">elapsed</div>
          {elapsed}s
        </div>
        <div>
          <div className="text-[10px] text-[var(--color-muted)]">target</div>
          {targetBaseUrl}
        </div>
        <div>
          <div className="text-[10px] text-[var(--color-muted)]">virtual users</div>
          {plan.target_vus}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {STAGES.map((s) => {
          const active = runState === s.state;
          const done = s.state === "QUEUED" ? runState === "RUNNING" || runState === "COMPLETED" : runState === "COMPLETED";
          return (
            <div key={s.state} className="flex items-center gap-2.5 text-[13px]">
              <StatusDot tone={done ? "success" : active ? "signal" : "muted"} pulse={active} />
              <span className={active ? "text-[var(--color-signal)]" : "text-[var(--color-ink-dim)]"}>{s.label}</span>
            </div>
          );
        })}
      </div>

      {plan.selected_endpoints.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[11px] text-[var(--color-muted)]">Live traffic mix</div>
          <div className="space-y-1.5">
            {plan.selected_endpoints.map((ep) => {
              const w = plan.endpoint_weights?.[ep] ?? 1;
              const total = plan.endpoint_weights
                ? Object.values(plan.endpoint_weights).reduce((a, b) => a + b, 0)
                : plan.selected_endpoints.length;
              const pct = Math.round((w / total) * 100);
              return (
                <div key={ep} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate font-mono text-[12px] text-[var(--color-ink-dim)]">{ep}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-raised)]">
                    <div
                      className="h-full animate-pulse rounded-full bg-[var(--color-signal)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
