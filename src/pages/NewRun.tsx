import { useState } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

type Phase = "compose" | "interpreting" | "review" | "clarify" | "invalid" | "launching";

interface InterpShape {
  status: string;
  intent?: Record<string, unknown> | null;
  reason?: string;
  interpreter?: string;
}
interface CompileShape {
  status: string;
  plan?: Record<string, unknown> | null;
  clarificationsNeeded?: { field: string; question: string }[];
  rejectionCode?: string;
  rejectionReason?: string;
  targetContract?: {
    targetClass?: string;
    verifications?: { endpoint: string; verified: boolean; status?: number; reason?: string }[];
  } | null;
}

const EXAMPLES = [
  "Baseline /products with 50 users for 30s, p95 under 400ms",
  "Stress /checkout up to 300 users — find the breaking point",
  "Soak /cart with 80 users for 60s",
];

export default function NewRun() {
  const [phase, setPhase] = useState<Phase>("compose");
  const [input, setInput] = useState("");
  const [target, setTarget] = useState("http://127.0.0.1:8080");
  const [interpretation, setInterpretation] = useState<InterpShape | null>(null);
  const [compilation, setCompilation] = useState<CompileShape | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState("");
  // Execution mode (Phase 5/10): explicit, never inferred. When on, the
  // approved plan is submitted to the FastAPI execution plane (LIVE_K6).
  const [executeViaBridge, setExecuteViaBridge] = useState(false);
  const bridgeConfigured = useQuery(api.queries.bridgeConfigured) ?? false;

  const interpretAndCompile = useAction(api.mutations.interpretAndCompile);
  const createRun = useMutation(api.mutations.createRun);
  const navigate = useNavigate();

  async function submitMission(text: string) {
    setError(null);
    setRawInput(text);
    setPhase("interpreting");
    try {
      const { interpretation: interp, compilation: comp } = await interpretAndCompile({ input: text });
      setInterpretation(interp as InterpShape);
      if (!comp) {
        setCompilation(null);
        setPhase("invalid");
        return;
      }
      setCompilation(comp as CompileShape);
      if (comp.status === "READY") setPhase("review");
      else if (comp.status === "NEEDS_CLARIFICATION") setPhase("clarify");
      else setPhase("invalid");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("compose");
    }
  }

  async function recompileWithAnswers() {
    if (!interpretation?.intent) return;
    const merged = {
      ...(interpretation.intent as Record<string, unknown>),
      clarificationsNeeded: Object.entries(answers).map(([field, question]) => ({ field, question })),
    };
    // Answers given as free text: simplest faithful loop is re-sending the
    // original NL input plus the answered questions appended to the objective.
    const answeredText = Object.entries(answers)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    await submitMission(answeredText ? `${rawInput} (${answeredText})` : rawInput);
    void merged;
  }

  async function approveAndLaunch() {
    if (!compilation?.plan) return;
    setPhase("launching");
    try {
      const runId = await createRun({
        plan: compilation.plan as never,
        targetBaseUrl: target.trim(),
        rawInput,
        interpreter: interpretation?.interpreter,
        executeViaBridge,
      });
      navigate(`/app/runs/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("review");
    }
  }

  const busy = phase === "interpreting" || phase === "launching";

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">New evaluation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Describe the goal. The pipeline interprets, compiles, and waits for your approval.
        </p>
      </div>

      {/* Pipeline progress */}
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {["compose", "interpret+compile", "approve", "execute"].map((s, i) => {
          const active =
            (s === "compose" && ["compose", "interpreting"].includes(phase)) ||
            (s === "interpret+compile" && ["interpreting", "clarify", "invalid", "review"].includes(phase)) ||
            (s === "approve" && phase === "review") ||
            (s === "execute" && phase === "launching");
          return (
            <span key={s} className="flex items-center gap-2">
              {i > 0 && <span className="text-border">→</span>}
              <span className={active ? "text-primary" : undefined}>{s}</span>
            </span>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Mission</CardTitle>
          <CardDescription>One line is enough. Load, duration, endpoints, thresholds — any subset.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mission">Performance objective</Label>
            <Textarea
              id="mission"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. Baseline /products with 50 users for 30s, p95 under 400ms"
              className="font-mono text-sm min-h-[84px]"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setInput(ex)}
                  className="rounded-md border border-border/60 bg-secondary/50 px-2 py-1 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target">Target base URL</Label>
            <Input id="target" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono text-sm" />
            <p className="text-[11px] text-muted-foreground">
              The demo API (<span className="font-mono">http://127.0.0.1:8080</span>) ships with a known endpoint contract. Any other URL is validated
              before planning: suggested paths are verified against the target and unverified paths are rejected — no application endpoints are invented. Cloud metadata hosts are always blocked.
            </p>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-400">{error}</div>
          )}
          <div className="flex gap-2">
            <Button
              disabled={busy || !input.trim()}
              onClick={() => submitMission(input.trim())}
            >
              {phase === "interpreting" ? "Interpreting…" : "Compile plan"}
            </Button>
            {phase !== "compose" && phase !== "interpreting" && (
              <Button variant="outline" onClick={() => { setPhase("compose"); setCompilation(null); setInterpretation(null); }}>
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Interpretation result */}
      {interpretation && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Interpretation
              <Badge variant={interpretation.status === "COMPLETE" ? "success" : interpretation.status === "INCOMPLETE" ? "warning" : "destructive"}>
                {interpretation.status}
              </Badge>
            </CardTitle>
            <CardDescription>
              via {interpretation.interpreter === "llm" ? "LLM interpreter" : "deterministic interpreter"}
              {interpretation.reason ? ` — ${interpretation.reason}` : ""}
            </CardDescription>
          </CardHeader>
          {interpretation.intent != null && (
            <CardContent>
              <pre className="max-h-52 overflow-auto scrollbar-thin rounded-md border border-border/60 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(interpretation.intent, null, 2)}
              </pre>
            </CardContent>
          )}
        </Card>
      )}

      {/* Clarifications */}
      {phase === "clarify" && compilation?.clarificationsNeeded && (
        <Card className="border-amber-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Clarifications needed
              <Badge variant="warning">{compilation.clarificationsNeeded.length}</Badge>
            </CardTitle>
            <CardDescription>Answer these and the mission recompiles. Nothing has been executed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {compilation.clarificationsNeeded.map((c) => (
              <div key={c.field} className="space-y-1.5">
                <Label htmlFor={c.field}>
                  <span className="font-mono text-xs text-primary/80">{c.field}</span> — {c.question}
                </Label>
                <Input
                  id={c.field}
                  value={answers[c.field] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [c.field]: e.target.value }))}
                  placeholder="e.g. 50"
                />
              </div>
            ))}
            <Button onClick={recompileWithAnswers} disabled={busy}>Recompile with answers</Button>
          </CardContent>
        </Card>
      )}

      {/* Approval gate */}
      {phase === "review" && compilation?.plan && (
        <Card className="border-primary/40 glow-ring">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Plan ready — approval required
              <Badge variant="success">READY</Badge>
            </CardTitle>
            <CardDescription>
              Compilation is side-effect-free. Nothing runs until you approve this plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="test type" value={String((compilation.plan as Record<string, unknown>).testType ?? "—")} />
              <Stat label="target VUs" value={String((compilation.plan as Record<string, unknown>).targetVus ?? "—")} />
              <Stat
                label="duration"
                value={String(
                  (compilation.plan as Record<string, unknown>).duration ??
                    `${(compilation.plan as Record<string, unknown>).rampDuration ?? ""} + ${(compilation.plan as Record<string, unknown>).holdDuration ?? ""}`,
                )}
              />
              <Stat label="endpoints" value={String((compilation.plan as unknown as { selectedEndpoints?: string[] }).selectedEndpoints?.length ?? 0)} />
            </div>
            {compilation.targetContract?.verifications && compilation.targetContract.verifications.length > 0 && (
              <div className="rounded-md border border-border/60 bg-background/60 p-3">
                <div className="text-xs text-muted-foreground mb-1">Endpoint verification (target contract)</div>
                <div className="space-y-0.5 font-mono text-xs">
                  {compilation.targetContract.verifications.map((v, i) => (
                    <div key={i} className={v.verified ? "text-emerald-400" : "text-red-400"}>
                      {v.verified ? "✓" : "✗"} {v.endpoint}
                      {v.status != null ? ` — HTTP ${v.status}` : v.reason ? ` — ${v.reason}` : ""}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Separator />
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Assumptions applied</div>
              <ul className="space-y-1">
                {((compilation.plan as unknown as { assumptions: string[] }).assumptions ?? []).map((a, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex gap-2">
                    <span className="text-primary/70 font-mono text-xs mt-0.5">▸</span>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border border-border/60 bg-background/60 p-3">
              <div className="text-xs text-muted-foreground mb-1">Target</div>
              <span className="font-mono text-sm text-primary">{target}</span>
            </div>
            {/* Execution mode selection — explicit (Phase 5/10). LIVE_K6 is
                only offered when an execution plane is configured; REAL_PROBE
                remains the always-available default. */}
            <div className="rounded-md border border-border/60 bg-background/60 p-3 space-y-2">
              <div className="text-xs text-muted-foreground">Execution mode</div>
              <label className="flex items-start gap-2.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="exec-mode"
                  checked={!executeViaBridge}
                  onChange={() => setExecuteViaBridge(false)}
                  className="mt-1 accent-violet-400"
                />
                <span>
                  <span className="font-mono text-xs text-violet-300">REAL_PROBE</span>
                  <span className="text-muted-foreground"> — bounded HTTP probe from Convex (reachability + latency observation; not sustained load, no capacity claims)</span>
                </span>
              </label>
              <label className={`flex items-start gap-2.5 text-sm ${bridgeConfigured ? "cursor-pointer" : "opacity-50"}`}>
                <input
                  type="radio"
                  name="exec-mode"
                  checked={executeViaBridge}
                  disabled={!bridgeConfigured}
                  onChange={() => setExecuteViaBridge(true)}
                  className="mt-1 accent-emerald-400"
                />
                <span>
                  <span className="font-mono text-xs text-emerald-300">LIVE_K6</span>
                  <span className="text-muted-foreground">
                    {bridgeConfigured
                      ? " — execute on the FastAPI execution plane with real k6 against the authorized target (sustained load, backend-authoritative metrics)"
                      : " — unavailable: no execution plane configured (EXECUTION_BRIDGE_URL missing)"}
                  </span>
                </span>
              </label>
            </div>
            <Button size="lg" className="w-full" disabled={busy} onClick={approveAndLaunch}>
              {busy ? "Launching…" : executeViaBridge ? "Approve & execute LIVE_K6" : "Approve & execute"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Invalid */}
      {phase === "invalid" && compilation?.rejectionCode === "unverified_endpoints" && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Target not verified
              <Badge variant="warning">NEEDS_CLARIFICATION</Badge>
            </CardTitle>
            <CardDescription>
              {compilation.rejectionReason} The target did not establish the requested path(s) as valid
              application/API operations, so no plan can run against them. Choose the site root, a target with an API
              contract, or provide the correct documented path.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {phase === "invalid" && compilation?.rejectionReason && compilation.rejectionCode !== "unverified_endpoints" && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Rejected
              <Badge variant="destructive">{compilation.rejectionCode ?? compilation.status}</Badge>
            </CardTitle>
            <CardDescription>
              {compilation.rejectionReason} Construct a different mission — retrying the same one will fail again.
            </CardDescription>
          </CardHeader>
          {compilation.status === "NEEDS_CLARIFICATION" && compilation.clarificationsNeeded && (
            <CardContent>
              <Progress value={0} />
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {compilation.clarificationsNeeded.map((c, i) => (
                  <li key={i}>• <span className="font-mono text-xs">{c.field}</span> — {c.question}</li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-medium text-primary">{value}</div>
    </div>
  );
}
