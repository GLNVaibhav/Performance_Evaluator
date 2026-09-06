import { useState } from "react";

interface Node {
  id: string;
  label: string;
  purpose: string;
  boundary: string;
  output: string;
}

const NODES: Node[] = [
  { id: "user", label: "User", purpose: "Describes a performance objective in plain language.", boundary: "No structured schema knowledge required.", output: "Natural language" },
  { id: "llm", label: "LLM interpreter", purpose: "Converts natural language into structured intent.", boundary: "Cannot execute workloads, cannot construct a TestPlan, cannot call the compiler itself.", output: "InterpretationResult" },
  { id: "intent", label: "UniversalPerformanceIntent", purpose: "The structured, possibly-incomplete representation of what the user wants.", boundary: "Never turned into k6 JavaScript directly.", output: "Validated intent" },
  { id: "compiler", label: "Deterministic compiler", purpose: "Validates and transforms intent into an executable TestPlan.", boundary: "No LLM execution authority — pure, deterministic function.", output: "TestPlan / clarification / rejection" },
  { id: "approval", label: "Human approval", purpose: "The system never automatically executes an AI-generated workload.", boundary: "Execution requires an explicit, separate confirmation.", output: "Approved TestPlan" },
  { id: "runservice", label: "RunService", purpose: "Persists the run and manages its lifecycle state.", boundary: "Unaware of how the plan was produced — intent or hand-authored, identical path.", output: "QUEUED run" },
  { id: "engine", label: "RealK6PerformanceEngine", purpose: "Renders and executes the actual k6 workload.", boundary: "Unaware that intent interpretation exists at all.", output: "Real k6 subprocess" },
  { id: "target", label: "Target API", purpose: "The system under test.", boundary: "Ordinary HTTP traffic, nothing test-framework-specific.", output: "Real responses" },
  { id: "result", label: "TestResult", purpose: "Deterministic metrics, threshold evaluation, per-endpoint breakdown.", boundary: "Every value traced back to k6's own output — nothing estimated.", output: "PASS / FAIL" },
];

export function ArchitecturePage() {
  const [active, setActive] = useState<Node>(NODES[3]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="text-[22px] font-semibold tracking-tight">Inside the performance intelligence engine</h1>
      <p className="mt-1 max-w-2xl text-[14px] text-[var(--color-ink-dim)]">
        Probabilistic interpretation may assist in understanding what you want. Deterministic code remains
        the sole authority for what actually executes.
      </p>

      <div className="mt-10 grid grid-cols-[1fr_320px] gap-10">
        <div className="flex flex-col">
          {NODES.map((node, i) => (
            <button
              key={node.id}
              onClick={() => setActive(node)}
              className={`flex items-center gap-4 rounded-md px-3 py-2.5 text-left transition-colors ${
                active.id === node.id ? "bg-[var(--color-panel-raised)]" : "hover:bg-[var(--color-panel)]"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  active.id === node.id
                    ? "bg-[var(--color-signal)] shadow-[0_0_8px_var(--color-signal)]"
                    : "bg-[var(--color-hairline)]"
                }`}
              />
              <span className={`text-[14px] ${active.id === node.id ? "text-[var(--color-ink)]" : "text-[var(--color-ink-dim)]"}`}>
                {node.label}
              </span>
              {i < NODES.length - 1 && <span className="ml-auto font-mono text-[11px] text-[var(--color-muted)]">↓</span>}
            </button>
          ))}
        </div>

        <div className="h-fit rounded-lg border border-[var(--color-signal)]/25 bg-[var(--color-panel)] p-5">
          <div className="text-[15px] font-semibold">{active.label}</div>
          <div className="mt-4">
            <div className="text-[11px] text-[var(--color-muted)]">Purpose</div>
            <div className="mt-0.5 text-[13px] text-[var(--color-ink-dim)]">{active.purpose}</div>
          </div>
          <div className="mt-4">
            <div className="text-[11px] text-[var(--color-muted)]">Boundary</div>
            <div className="mt-0.5 text-[13px] text-[var(--color-ink-dim)]">{active.boundary}</div>
          </div>
          <div className="mt-4">
            <div className="text-[11px] text-[var(--color-muted)]">Output</div>
            <div className="mt-0.5 font-mono text-[13px] text-[var(--color-signal)]">{active.output}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
