/**
 * AI Performance Intelligence — ANALYST ("use node" action; Phase 9).
 *
 * The AI is an analyst, never an execution agent: this module can only
 * READ stored runs / boundary searches and APPEND a versioned analysis.
 * It has no access to any function that creates runs, changes plans,
 * thresholds, VU levels, safety limits, targets, or history.
 *
 * Pipeline: stored documents → deterministic evidence (evidence.ts,
 * including the numeric registry) → LLM (interpretation only, JSON mode)
 * → deterministic validation/sanitization (validate.ts) → append-only
 * storage (runtime.ts). If no LLM key is configured, or the model or
 * validation fails, a deterministic analysis is produced instead and the
 * stored TestResult/boundary state remains untouched throughout.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  buildRunEvidence,
  buildSearchEvidence,
  PROMPT_VERSION,
  type Evidence,
  type RunEvidence,
  type SearchEvidence,
} from "./ai/evidence";
import { validateAnalysis } from "./ai/validate";

// --- system prompt (§15) ------------------------------------------------------

const SYSTEM_PROMPT = `You are a performance-analysis assistant.

You do not execute tests.
You do not control experiments.
You do not select workloads.
You do not determine safety limits.
You do not invent measurements.
You may only interpret the supplied evidence.

CLASSIFICATION RULES — every statement must be exactly one of:
- OBSERVED: directly supported by one or more recorded measurements. Every number you
  state must appear verbatim in the supplied evidence. Cite the evidence references.
- INFERRED: a reasonable interpretation supported by MULTIPLE recorded observations.
  Never present an inference as an observed fact.
- UNKNOWN: something the evidence cannot establish. Prefer stating an unknown over guessing.

EXECUTION-MODE RULES:
- live_k6: measurements came from an actual k6 execution. You may describe sustained-load observations.
- real: measurements came from bounded HTTP probing; do not claim sustained-load capacity or saturation.
- simulation: the result is simulated; do not interpret it as an observed target measurement.

ROOT-CAUSE DISCIPLINE:
- Never claim a subsystem (database, cache, connection pool, GC, locks, ...) is the cause.
  The measurements show WHERE and WHICH threshold, never WHY.
- If the evidence includes a controlled demo condition (configured mode), you may mention it
  as contextual configuration only — never claim the experiment proves a production-equivalent
  subsystem problem.

CAPACITY DISCIPLINE:
- Never claim exact capacity, maximum capacity, or that the system can handle exactly N users.
- For a boundary search, the only permitted framing is "estimated safe operating region",
  "highest observed passing load", "lowest observed failing load", "observed threshold violation".

OUTPUT:
Return ONLY a JSON object with exactly these keys:
{
  "summary": string (<= 600 chars),
  "observations": [{ "statement": string, "classification": "OBSERVED"|"INFERRED"|"UNKNOWN", "evidence": [string] }],
  "threshold_assessment": { "status": string, "evidence": [string] },
  "endpoint_observations": [{ "endpoint": string, "statement": string, "classification": string, "evidence": [string] }],
  "boundary_assessment": { "highest_observed_pass": number|null, "lowest_observed_fail": number|null },
  "limitations": [string],
  "confidence_notes": [string]
}
Every evidence[] entry must be copied verbatim from the supplied evidence_keys.
Statements failing validation are dropped — an empty output is acceptable when evidence is thin.`;

// --- LLM call ------------------------------------------------------------------

interface LlmRawResponse {
  summary?: unknown;
  observations?: unknown;
  threshold_assessment?: unknown;
  endpoint_observations?: unknown;
  boundary_assessment?: unknown;
  limitations?: unknown;
  confidence_notes?: unknown;
}

async function callLlm(evidence: Evidence): Promise<{ raw: LlmRawResponse; model: string } | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://perforso.app",
        "X-Title": "Perforso Performance Evaluator",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              instruction:
                "Interpret this evidence. Classify every statement OBSERVED/INFERRED/UNKNOWN. Use only numbers present in `numbers` and only references present in `evidence_keys`.",
              evidence,
            }),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    const fenced = content.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const f = fenced.indexOf("{");
    const l = fenced.lastIndexOf("}");
    const text = f !== -1 && l > f ? fenced.slice(f, l + 1) : fenced;
    return { raw: JSON.parse(text) as LlmRawResponse, model };
  } catch {
    return null;
  }
}

// --- deterministic fallback (§12: incomplete data stated, never estimated) ------

function deterministicRunAnalysis(e: RunEvidence) {
  const numbers = e.numbers;
  const kRun = `run.${e.runId}`;
  const num = (key: string) => numbers[key];
  const fmt = (v: number | undefined) => (v === undefined ? "n/a" : `${Math.round(v * 100) / 100}`);

  const observations: { statement: string; classification: string; evidence: string[] }[] = [];
  const kP95 = `${kRun}.metrics.p95`;
  const kThr = `${kRun}.thresholds.p95LatencyMs`;
  const kErr = `${kRun}.metrics.errorRatePct`;
  const kReq = `${kRun}.metrics.requests`;
  if (e.status === "execution_error") {
    observations.push({
      statement: `The run ended in EXECUTION_ERROR: no performance verdict can be inferred from it.`,
      classification: "UNKNOWN" as const,
      evidence: [`run:${e.runId}`, `mode:${e.executionMode}`],
    });
  } else if (num(kP95) !== undefined && num(kThr) !== undefined) {
    observations.push({
      statement: `At ${fmt(num(`${kRun}.metrics.targetVus`))} VUs, p95 latency was ${fmt(num(kP95))}ms against the configured ${fmt(num(kThr))}ms threshold.`,
      classification: "OBSERVED" as const,
      evidence: [kP95, kThr, `${kRun}.metrics.targetVus`],
    });
  }
  if (num(kErr) !== undefined && num(kReq) !== undefined) {
    observations.push({
      statement: `The run recorded ${num(kReq)} requests with an observed error rate of ${fmt(num(kErr))}%.`,
      classification: "OBSERVED" as const,
      evidence: [kErr, kReq],
    });
  }
  observations.push({
    statement: `These measurements do not establish the exact maximum sustainable capacity of the target.`,
    classification: "UNKNOWN" as const,
    evidence: [`mode:${e.executionMode}`],
  });

  const thresholds = e.plan?.thresholds ?? { p95LatencyMs: null, errorRatePct: null };
  const p95 = e.metrics?.p95 ?? null;
  const violations: string[] = [];
  if (thresholds.p95LatencyMs !== null && p95 !== null && p95 > thresholds.p95LatencyMs) {
    violations.push(`p95 latency ${Math.round(p95 * 100) / 100}ms exceeded the configured ${thresholds.p95LatencyMs}ms threshold`);
  }
  if (
    thresholds.errorRatePct !== null &&
    e.metrics?.errorRatePct !== null &&
    e.metrics &&
    e.metrics.errorRatePct > thresholds.errorRatePct
  ) {
    violations.push(`error rate ${e.metrics.errorRatePct}% exceeded the configured ${thresholds.errorRatePct}% budget`);
  }

  return {
    summary:
      e.status === "execution_error"
        ? `LIVE execution ended in EXECUTION_ERROR; no performance verdict is available.`
        : `${e.executionMode} experiment on ${e.targetLabel ?? "the recorded target"}: ${
            e.metrics?.totalRequests ?? "?"
          } requests, p95 ${fmt(e.metrics?.p95 ?? undefined)}ms, error rate ${fmt(e.metrics?.errorRatePct ?? undefined)}%.`,
    observations,
    threshold_assessment: {
      status: e.thresholdStatus ?? "NOT_ASSESSED",
      evidence: e.thresholdStatus ? [`thresholdStatus:${e.thresholdStatus}`] : [],
    },
    endpoint_observations: [] as { endpoint: string; statement: string; classification: string; evidence: string[] }[],
    boundary_assessment: { highest_observed_pass: null, lowest_observed_fail: null },
    limitations: e.limitations,
    confidence_notes: violations.length
      ? ["Observed threshold violations are listed in the deterministic result; this analysis restates them, never re-derives them."]
      : ["Threshold verdict is backend-authoritative; this analysis does not alter it."],
  };
}

function deterministicSearchAnalysis(e: SearchEvidence) {
  const seq = e.experiments
    .filter((x) => x.thresholdStatus !== null)
    .map((x) => `${x.targetVus} VU → ${x.thresholdStatus}`)
    .join(", ");
  const observations: { statement: string; classification: string; evidence: string[] }[] = [
    {
      statement: `Observed sequence: ${seq || "no completed experiments"}.`,
      classification: "OBSERVED" as const,
      evidence: e.experiments.slice(0, 3).map((x) => `iteration:${x.iteration}`),
    },
  ];
  if (e.lowestKnownPassVus !== null) {
    observations.push({
      statement: `The highest observed passing load was ${e.lowestKnownPassVus} VUs.`,
      classification: "OBSERVED" as const,
      evidence: [`search.${e.searchId}.lowestKnownPassVus`],
    });
  }
  if (e.highestKnownFailVus !== null) {
    observations.push({
      statement: `The lowest observed failing load was ${e.highestKnownFailVus} VUs.`,
      classification: "OBSERVED" as const,
      evidence: [`search.${e.searchId}.highestKnownFailVus`],
    });
  }
  observations.push({
    statement: `The experiments do not establish the exact maximum sustainable capacity of the target.`,
    classification: "UNKNOWN" as const,
    evidence: [`search:${e.searchId}`],
  });
  return {
    summary: e.result
      ? `Boundary search finished (${e.result.stopReason ?? e.result.status}): highest observed passing load ${
          e.result.lowerBound ?? "unknown"
        } VUs, lowest observed failing load ${e.result.upperBound ?? "not observed"}. Estimated safe operating region stated below — not an exact capacity.`
      : `Boundary search in progress (${e.experimentCount} experiments so far).`,
    observations,
    threshold_assessment: { status: "NOT_ASSESSED", evidence: [] },
    endpoint_observations: [] as { endpoint: string; statement: string; classification: string; evidence: string[] }[],
    boundary_assessment: {
      highest_observed_pass: e.lowestKnownPassVus,
      lowest_observed_fail: e.highestKnownFailVus,
    },
    limitations: e.limitations,
    confidence_notes: [
      e.result?.stopReason
        ? `The search stopped because: ${e.result.stopReason}.`
        : "The search has not stopped yet; boundary values may still change.",
    ],
  };
}

// --- the action -----------------------------------------------------------------

/**
 * Convex's v.optional(...) accepts ABSENT fields, never explicit nulls.
 * Strip null/undefined values recursively before persisting (an absent
 * optional field IS the "unknown" representation).
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripNulls(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out as unknown as T;
  }
  return value;
}

export const analyzeRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    const run = await ctx.runQuery(internal.aiRuntimeDb.getRun, { runId: args.runId });
    if (!run) throw new Error(`run not found: ${args.runId}`);
    const userId: Id<"users"> = run.userId;
    const evidence = buildRunEvidence(run);

    const llm = await callLlm(evidence);
    const raw = llm?.raw ?? deterministicRunAnalysis(evidence);
    const validated = validateAnalysis(raw, evidence);

    const stored = await ctx.runMutation(internal.aiRuntimeDb.storeAnalysis, {
      userId,
      subjectKind: "run",
      runId: args.runId,
      analyzerKind: llm ? "llm" : "deterministic",
      model: llm?.model,
      promptVersion: PROMPT_VERSION,
      analysis: stripNulls(validated),
      evidenceRefs: evidence.evidenceKeys.slice(0, 200),
    });
    return stored;
  },
});

export const analyzeSearch = internalAction({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    const search = await ctx.runQuery(internal.aiRuntimeDb.getSearch, { searchId: args.searchId });
    if (!search) throw new Error(`boundary search not found: ${args.searchId}`);
    const userId: Id<"users"> = search.userId;

    const experimentRows = (await ctx.runQuery(internal.boundarySearchDb.listSearchExperiments, {
      searchId: args.searchId,
    })) as { runId: string; iteration: number; targetVus: number; status: string; thresholdStatus: string | null; externalRunId: string | null }[];
    // Metrics for each iteration come from the stored run documents.
    const enriched: {
      runId: string;
      iteration: number;
      targetVus: number;
      status: string;
      thresholdStatus: string | null;
      externalRunId: string | null;
      metrics: unknown;
    }[] = [];
    for (const row of experimentRows) {
      const r = (await ctx.runQuery(internal.aiRuntimeDb.getRun, { runId: row.runId as never })) as
        | { metrics?: unknown }
        | null;
      enriched.push({ ...row, metrics: r?.metrics ?? null });
    }
    const evidence = buildSearchEvidence(search, enriched);

    const llm = await callLlm(evidence);
    const raw = llm?.raw ?? deterministicSearchAnalysis(evidence);
    const validated = validateAnalysis(raw, evidence);

    const stored = await ctx.runMutation(internal.aiRuntimeDb.storeAnalysis, {
      userId,
      subjectKind: "boundary_search",
      boundarySearchId: args.searchId,
      analyzerKind: llm ? "llm" : "deterministic",
      model: llm?.model,
      promptVersion: PROMPT_VERSION,
      analysis: stripNulls(validated),
      evidenceRefs: evidence.evidenceKeys.slice(0, 200),
    });
    return stored;
  },
});
