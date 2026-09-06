import { useEffect, useState } from "react";
import { useMission } from "../state/useMission";
import { intentsApi } from "../api/intents";
import { MissionComposer } from "../components/mission/MissionComposer";
import { PipelineStepper } from "../components/pipeline/PipelineStepper";
import { InterpretationPanel } from "../components/intent/InterpretationPanel";
import { CompilationPanel } from "../components/compiler/CompilationPanel";
import { ApprovalGate } from "../components/approval/ApprovalGate";
import { ExecutionPanel } from "../components/execution/ExecutionPanel";
import { ResultsPanel } from "../components/results/ResultsPanel";
import { RotateCcw } from "lucide-react";

export function MissionControlPage() {
  const { state, reset, submitMission, approveAndExecute } = useMission();
  const [knownEndpoints, setKnownEndpoints] = useState<string[]>([]);

  useEffect(() => {
    intentsApi
      .knownEndpoints()
      .then((r) => setKnownEndpoints(r.endpoints))
      .catch(() => {});
  }, []);

  const isIdle = state.stage === "idle";

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-10 flex items-start justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Tell the agent what you want to test.</h1>
          <p className="mt-2 max-w-xl text-[14px] text-[var(--color-ink-dim)]">
            Describe your performance objective in natural language. The system interprets, validates,
            compiles, and prepares a real k6 workload — nothing executes until you approve it.
          </p>
        </div>
        {!isIdle && (
          <button
            onClick={reset}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-hairline)] px-3 py-1.5 text-[12px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
          >
            <RotateCcw size={12} />
            New mission
          </button>
        )}
      </header>

      {isIdle && (
        <MissionComposer disabled={false} onSubmit={submitMission} knownEndpoints={knownEndpoints} />
      )}

      {!isIdle && (
        <div className="grid grid-cols-[220px_1fr] gap-10">
          <div className="pt-2">
            <PipelineStepper stage={state.stage} />
          </div>

          <div className="space-y-5 pb-16">
            <div className="rounded-lg border border-[var(--color-hairline)] bg-black/20 px-4 py-3">
              <div className="text-[11px] text-[var(--color-muted)]">Mission</div>
              <div className="mt-0.5 text-[14px] text-[var(--color-ink-dim)]">{state.input}</div>
            </div>

            {state.networkError && (
              <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-dim)]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
                {state.networkError}
              </div>
            )}

            {state.interpretation && <InterpretationPanel result={state.interpretation} />}

            {state.compilation && <CompilationPanel result={state.compilation} />}

            {state.stage === "awaiting_approval" && state.compilation?.test_plan && (
              <ApprovalGate
                plan={state.compilation.test_plan}
                targetBaseUrl={state.targetBaseUrl}
                onApprove={approveAndExecute}
                busy={false}
              />
            )}

            {(state.stage === "launching" || state.stage === "running") && state.compilation?.test_plan && (
              <ExecutionPanel
                runId={state.runId ?? "…"}
                runState={state.runState ?? "QUEUED"}
                plan={state.compilation.test_plan}
                targetBaseUrl={state.targetBaseUrl}
              />
            )}

            {state.stage === "execution_error" && (
              <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-dim)]/20 p-5">
                <div className="text-[14px] font-medium text-[var(--color-danger)]">Execution failed</div>
                <div className="mt-1 text-[13px] text-[var(--color-ink-dim)]">{state.runErrorMessage}</div>
                <div className="mt-2 text-[12px] text-[var(--color-muted)]">
                  This is an execution failure, not a performance threshold breach — the k6 process itself
                  could not complete.
                </div>
              </div>
            )}

            {state.stage === "completed" && state.result && <ResultsPanel result={state.result} />}
          </div>
        </div>
      )}
    </div>
  );
}
