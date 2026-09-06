import type { ReactElement } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { MissionStage } from "../../state/useMission";

type StepStatus = "idle" | "active" | "done" | "warning" | "failed";

interface Step {
  n: string;
  name: string;
  detail: string;
}

const STEPS: Step[] = [
  { n: "01", name: "Mission received", detail: "Natural-language objective captured" },
  { n: "02", name: "AI interpretation", detail: "POST /intents/interpret" },
  { n: "03", name: "Deterministic compilation", detail: "POST /intents/compile" },
  { n: "04", name: "Human approval", detail: "Execution requires explicit confirmation" },
  { n: "05", name: "K6 execution", detail: "POST /runs · real k6 subprocess" },
  { n: "06", name: "Performance intelligence", detail: "GET /runs/{id}/result" },
];

// Maps the real mission-state stage onto each step's visual status. Kept as
// one explicit table per stage rather than index arithmetic, so it's
// obvious at a glance which real backend state lights up which step.
function statusesFor(stage: MissionStage): StepStatus[] {
  const idle: StepStatus[] = ["idle", "idle", "idle", "idle", "idle", "idle"];
  switch (stage) {
    case "idle":
      return idle;
    case "interpreting":
      return ["done", "active", "idle", "idle", "idle", "idle"];
    case "interpreted":
      return ["done", "done", "idle", "idle", "idle", "idle"];
    case "compiling":
      return ["done", "done", "active", "idle", "idle", "idle"];
    case "compiled":
    case "awaiting_approval":
      return ["done", "done", "done", "active", "idle", "idle"];
    case "blocked":
      // Warning shows on whichever real stage produced the blocking
      // status -- interpretation (AMBIGUOUS/INVALID/FAILURE) or
      // compilation (NEEDS_CLARIFICATION/INVALID).
      return ["done", "done", "warning", "idle", "idle", "idle"];
    case "launching":
      return ["done", "done", "done", "done", "active", "idle"];
    case "running":
      return ["done", "done", "done", "done", "active", "idle"];
    case "completed":
      return ["done", "done", "done", "done", "done", "done"];
    case "execution_error":
      return ["done", "done", "done", "done", "failed", "idle"];
    default:
      return idle;
  }
}

const ICON_FOR: Record<StepStatus, ReactElement | null> = {
  idle: null,
  active: <Loader2 size={13} className="animate-spin" />,
  done: <Check size={13} strokeWidth={3} />,
  warning: <span className="text-[10px] font-bold">!</span>,
  failed: <X size={13} strokeWidth={3} />,
};

const RING: Record<StepStatus, string> = {
  idle: "border-[var(--color-hairline)] text-[var(--color-muted)]",
  active: "border-[var(--color-signal)] text-[var(--color-signal)] shadow-[0_0_12px_rgba(56,189,248,0.35)]",
  done: "border-[var(--color-success)] bg-[var(--color-success-dim)] text-[var(--color-success)]",
  warning: "border-[var(--color-warning)] bg-[var(--color-warning-dim)] text-[var(--color-warning)]",
  failed: "border-[var(--color-danger)] bg-[var(--color-danger-dim)] text-[var(--color-danger)]",
};

export function PipelineStepper({ stage }: { stage: MissionStage }) {
  const statuses = statusesFor(stage);
  return (
    <div className="flex flex-col">
      {STEPS.map((step, i) => {
        const status = statuses[i];
        const isLast = i === STEPS.length - 1;
        return (
          <div key={step.n} className="flex gap-4">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-all duration-300 ${RING[status]}`}
              >
                {ICON_FOR[status] ?? <span className="font-mono text-[10px]">{step.n}</span>}
              </div>
              {!isLast && (
                <div
                  className={`w-px flex-1 min-h-[22px] transition-colors duration-500 ${
                    status === "done" ? "bg-[var(--color-success)]/50" : "bg-[var(--color-hairline)]"
                  }`}
                />
              )}
            </div>
            <div className={`pb-6 ${status === "idle" ? "opacity-40" : ""}`}>
              <div
                className={`text-[13px] font-medium transition-colors ${
                  status === "active" ? "text-[var(--color-signal)]" : "text-[var(--color-ink)]"
                }`}
              >
                {step.name}
              </div>
              <div className="font-mono text-[11px] text-[var(--color-ink-dim)]">{step.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
