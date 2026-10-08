/**
 * Port of backend/app/services/ai_analyzer.py (+ provider seam) and the
 * terminal-report narration. Consumes engine totals + threshold outcome and
 * produces failure localization and recommendations. LLM-backed when a key
 * is configured, deterministic otherwise. Never executes anything.
 */
import type { EngineTotals } from "./engine";
import type { CompiledPlan } from "./compiler";
import type { EndpointVerification } from "./targetContract";

export interface AnalysisResult {
  summary: string;
  points: string[];
  analyzer: "llm" | "deterministic";
  score: number;
}

interface AnalyzeInput {
  plan: CompiledPlan;
  targetBaseUrl: string;
  totals: EngineTotals;
  thresholdStatus: "PASS" | "FAIL";
  violations: string[];
  breakpoint: { stage: string; vus: number } | null;
  capacityVus: number;
  mode: "real" | "simulation";
  /** Target-contract outcome for the plan's endpoints (arbitrary-URL targets). */
  endpointsVerification?: EndpointVerification[] | null;
  /** Short reason the endpoints could not be verified (from executeRun's gate). */
  unverifiedReason?: string | null;
  probe: {
    requests: number;
    statuses: number[];
    networkErrors: number;
    probeUrls: string[];
    errorSample: string | null;
  } | null;
}

const SYSTEM_PROMPT_HEAD = `You are a performance engineer writing the "why" section of a load-test report.
Given JSON metrics, produce JSON only: {"summary": string (<= 320 chars), "points": string[] (3-5 bullets)}.
The payload includes engineMode: "real" (measured HTTP probe evidence — analyze ONLY what was measured:
latency percentiles, status-code mix, network errors, edge/CDN behaviour; never claim saturation or
load capacity from a bounded probe) or "simulation" (modeled closed-load data — full saturation and
capacity reasoning is allowed). Each bullet must localize a cause or prescribe a concrete, mode-appropriate
action. No fluff, no markdown, no prose outside JSON.`;

const SYSTEM_PROMPT_TAIL = `
EVIDENCE RULES (all modes):
- Separate OBSERVED (exact counts: "N requests to path returned non-2xx"), UNKNOWN (why the server
  responded that way — you cannot see the server), and FORBIDDEN (any claim that the target has or
  lacks a named application subsystem, that a named path is a real application/API operation, or that
  a named subsystem is misconfigured). "Checkout", "cart", "login", "payment", "orders" etc. are
  NOT evidence — a 404/4xx/5xx on a path proves only that the path returned that status during the run.
- When endpointsVerification is present and any entry is verified:false, the run established NO valid
  application operation: say exactly that and DO NOT localize the responses into any application
  subsystem. Nothing about the application's behaviour or capacity can be concluded from such a run.
- Never propose "review/fix/check the X endpoint/subsystem for misconfiguration" from HTTP status
  evidence alone — propose verification or instrumentation steps instead.`;

const SYSTEM_PROMPT = SYSTEM_PROMPT_HEAD + SYSTEM_PROMPT_TAIL;

export async function analyze(input: AnalyzeInput): Promise<AnalysisResult> {
  const { totals, plan, thresholdStatus, violations, breakpoint, mode, probe } = input;
  const errPct = (totals.errorRate * 100).toFixed(2);
  const statusCounts = probe
    ? probe.statuses.reduce<Record<string, number>>((acc, s) => {
        const key = s === 0 ? "network" : `${Math.floor(s / 100)}xx`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const statusSummary = Object.entries(statusCounts)
    .map(([k, v]) => `${v}×${k}`)
    .join(", ");

  const deterministic = (): AnalysisResult => {
    const points: string[] = [];

    if (mode === "real") {
      const unverified = (input.endpointsVerification ?? []).filter((v) => !v.verified);
      if (unverified.length) {
        // Unverified endpoints: evidence-only narrative — OBSERVED / UNKNOWN /
        // UNSUPPORTED INFERENCE. No application semantics may be concluded.
        const statusMix = statusSummary || "no completed responses";
        points.push(
          `OBSERVED: ${totals.totalRequests} request(s) to ${probe?.probeUrls.join(", ") ?? input.targetBaseUrl} returned ${statusMix}.`,
        );
        points.push(
          `UNKNOWN: why the server returned those responses — the run measured HTTP status codes and latency only; the application behind them was not observed.`,
        );
        points.push(
          `UNSUPPORTED INFERENCE: any claim that this target has a ${unverified.map((u) => JSON.stringify(u.endpoint)).join(" or ")} application/API operation, or that one is misconfigured. The endpoint could not be established as a valid application/API operation, so this run is insufficient to infer application performance or capacity.`,
        );
        points.push(
          `Next step: verify the path against the target's API contract (e.g. OpenAPI) or choose a documented endpoint, then re-run. This bounded probe validated reachability only.`,
        );
        const summary =
          `The selected path returned non-2xx responses. The endpoint could not be established as a valid application/API operation, so this run is insufficient to infer application performance or capacity. ` +
          `${violations.length ? `Probe failed configured response/error thresholds (${violations.join("; ")}). ` : ""}` +
          `Insufficient evidence for capacity/saturation inference.`;
        return { summary, points, analyzer: "deterministic", score: 25 };
      }
      // Real-traffic narrative: measured evidence only, no saturation claims.
      points.push(
        `Measured ${totals.totalRequests} real requests against ${probe?.probeUrls.length ?? 1} probe URL(s) — response mix: ${statusSummary || "none"}.`,
      );
      points.push(
        `Measured p95 latency ${totals.p95}ms (p50 ${totals.p50}ms, p99 ${totals.p99}ms) against the ${plan.thresholds.p95LatencyMs}ms threshold${totals.p95 > plan.thresholds.p95LatencyMs ? " — breached; consider a CDN/cache layer or origin profiling (TTFB vs render-blocking assets)" : " — within budget"}.`,
      );
      if (totals.totalFailures > 0) {
        points.push(
          `${totals.totalFailures} failed requests (${errPct}%): ${probe?.networkErrors ? `${probe.networkErrors} network-level (DNS/TLS/timeout)` : ""}${probe?.networkErrors && statusCounts["5xx"] ? ", " : ""}${statusCounts["5xx"] ? `${statusCounts["5xx"]} server-side 5xx` : ""}${statusCounts["4xx"] ? `, ${statusCounts["4xx"]} client-side 4xx` : ""}. ${probe?.errorSample ? `Last error: "${probe.errorSample}".` : ""}`,
        );
      }
      points.push(
        `Workload context: the plan requested up to ${plan.targetVus} VUs; this probe actually ran bounded (≤4 concurrent GETs, peak ${totals.peakVus} in flight) so it validates availability + baseline latency, not the requested load and not full saturation. Pair with the k6 binary from backend/ for true load ceilings.`,
      );
      const summary =
        thresholdStatus === "PASS"
          ? `Real-traffic probe: ${totals.totalRequests} requests, p95 ${totals.p95}ms, ${errPct}% errors — thresholds met (p95 ≤ ${plan.thresholds.p95LatencyMs}ms, errors ≤ ${(plan.thresholds.errorRate * 100).toFixed(1)}%).`
          : `Probe failed configured response/error thresholds (${violations.join("; ")}). Insufficient evidence for capacity/saturation inference — measured evidence below.`;
      return { summary, points, analyzer: "deterministic", score: Math.max(5, Math.min(100, Math.round(100 - (totals.p95 > plan.thresholds.p95LatencyMs ? 30 : 0) - totals.errorRate * 400))) };
    }

    // Simulation narrative (unchanged semantics)
    if (breakpoint) {
      points.push(
        `Saturation begins around ${breakpoint.vus} VUs during "${breakpoint.stage}" (modeled capacity ≈ ${input.capacityVus} VUs) — latency doubles past this point, consistent with connection-pool or worker-thread exhaustion.`,
      );
    } else {
      points.push(
        `No saturation up to ${totals.peakVus} VUs: the system stayed inside its elastic envelope. Re-run with a higher ceiling to find the true breaking point.`,
      );
    }
    if (totals.p99 > 1.8 * totals.p95) {
      points.push(
        `Tail latency is severe (p99 ${totals.p99}ms vs p95 ${totals.p95}ms, ${(totals.p99 / Math.max(1, totals.p95)).toFixed(1)}×) — suspect GC pauses, lock contention, or unbounded queues.`,
      );
    }
    if (totals.errorRate > plan.thresholds.errorRate) {
      points.push(
        `Error rate ${errPct}% breached the ${(plan.thresholds.errorRate * 100).toFixed(1)}% budget — check upstream timeouts, circuit breakers, and DB connection limits before the next deploy.`,
      );
    }
    if (totals.maxRps < totals.peakVus * 8) {
      points.push(
        `Peak throughput ${totals.maxRps} req/s is below the theoretical ~${Math.round(totals.peakVus * 8)} req/s at ${totals.peakVus} VUs — throughput plateaus before concurrency does, hinting at a serialized resource (cache lock, single-writer DB).`,
      );
    }
    points.push(
      `Recommendation: autoscale at ~70% of the breaking point (${breakpoint ? Math.round(breakpoint.vus * 0.7) : Math.round(totals.peakVus * 0.7)} VUs) and re-run this exact plan after each deploy to catch regressions.`,
    );

    const summary =
      thresholdStatus === "PASS"
        ? `Held ${totals.peakVus} VUs at ${totals.maxRps} req/s with p95 ${totals.p95}ms and ${errPct}% errors — thresholds met (p95 ≤ ${plan.thresholds.p95LatencyMs}ms, errors ≤ ${(plan.thresholds.errorRate * 100).toFixed(1)}%).`
        : `Thresholds violated: ${violations.join("; ")}. Breaking point at ${breakpoint ? `${breakpoint.vus} VUs (${breakpoint.stage})` : "the planned ceiling"}; see analysis for remediation.`;

    let score = 100;
    score -= Math.min(35, Math.max(0, (totals.p95 - 200) / 25));
    score -= Math.min(35, totals.errorRate * 400);
    if (totals.maxRps < 400) score -= 8;
    if (thresholdStatus === "FAIL") score = Math.min(score, 55);

    return { summary, points, analyzer: "deterministic", score: Math.max(5, Math.min(100, Math.round(score))) };
  };

  if (!process.env.LLM_API_KEY) return deterministic();

  try {
    const baseUrl = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const model = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://perforso.app",
        "X-Title": "Perforso Performance Evaluator",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              plan: {
                testType: plan.testType,
                objectiveType: plan.objectiveType,
                targetVus: plan.targetVus,
                endpoints: plan.selectedEndpoints,
                thresholds: plan.thresholds,
                assumptions: plan.assumptions,
              },
              target: input.targetBaseUrl,
              metrics: {
                totalRequests: totals.totalRequests,
                totalFailures: totals.totalFailures,
                errorRatePct: +(totals.errorRate * 100).toFixed(2),
                p50: totals.p50,
                p95: totals.p95,
                p99: totals.p99,
                maxRps: totals.maxRps,
                peakVus: totals.peakVus,
              },
              thresholdStatus,
              violations,
              breakpoint,
              engineMode: mode,
              endpointsVerification: input.endpointsVerification ?? null,
              unverifiedReason: input.unverifiedReason ?? null,
              probeEvidence: probe
                ? {
                    requests: probe.requests,
                    statusMix: statusSummary || "none",
                    networkErrors: probe.networkErrors,
                    probeUrls: probe.probeUrls,
                  }
                : null,
            }),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const fenced = (data.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const f = fenced.indexOf("{");
    const l = fenced.lastIndexOf("}");
    const text = f !== -1 && l > f ? fenced.slice(f, l + 1) : fenced;
    const parsed = JSON.parse(text) as { summary?: string; points?: string[] };
    if (!parsed.summary || !Array.isArray(parsed.points) || !parsed.points.length) {
      throw new Error("malformed analyzer JSON");
    }
    const det = deterministic();
    // Guardrail (BUG 2): with unverified endpoints the deterministic evidence-
    // only narrative is authoritative — the LLM must not add application
    // semantics the evidence cannot support. Its bullets, if any, are dropped.
    const hasUnverified = (input.endpointsVerification ?? []).some((v) => !v.verified);
    if (mode === "real" && hasUnverified) {
      return { ...det, analyzer: "deterministic" as const };
    }
    return { summary: parsed.summary, points: parsed.points.slice(0, 6), analyzer: "llm" as const, score: det.score };
  } catch {
    return deterministic();
  }
}
