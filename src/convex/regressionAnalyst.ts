/**
 * PERFORMANCE REGRESSION INTELLIGENCE — ANALYST ("use node" action; Phase 10).
 *
 * The AI is downstream and interpretation-ONLY: it receives the deterministic
 * regression object plus both runs' evidence registries, and returns an
 * interpretation that is validated (aiValidate.ts) before anything is stored.
 * The AI cannot modify metrics, classifications, compatibility, or runs —
 * the deterministic object is computed once by the pure engine and stored
 * verbatim; the AI's versioned interpretation is stored alongside it.
 *
 * If no LLM key is configured, or the model or validation fails, a
 * deterministic restatement (built from the regression object itself) is
 * stored instead and labeled analyzerKind "deterministic".
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  buildRegressionEvidence,
  REGRESSION_PROMPT_VERSION,
  type RegressionEvidence,
} from "./regression/aiEvidence";
import { validateRegressionAnalysis } from "./regression/aiValidate";
import type { DeterministicRegressionObject } from "./regression/core";

// --- system prompt (§12/§13) ----------------------------------------------------

const SYSTEM_PROMPT = `You are a performance-regression interpreter.

You do not compute metrics. You do not decide regressions. You do not re-derive
deltas. A deterministic engine has already compared two compatible runs and
produced the regression object you receive. Your job is limited to explaining
WHAT CHANGED, using only the supplied evidence.

RULES:
- Restate deterministic numbers verbatim. Never invent, round differently, or
  re-derive a number that is not in the evidence.
- Never modify, contradict, or re-classify the deterministic classification,
  compatibility verdict, or policy outcome.
- Classify every statement OBSERVED (backed by cited evidence), INFERRED
  (supported by multiple observations), or UNKNOWN (prefer this over guessing).
- Root-cause discipline: never claim a subsystem (database, cache, CPU, network,
  ...) caused the regression. The measurements show WHERE and WHAT changed,
  never WHY. If a controlled demo condition is present in the evidence you may
  mention it as contextual configuration only.
- No subjective verdicts: the words good/bad/better/worse do not appear in a
  factual regression report.
- If the comparison is INCONCLUSIVE, say what is unknown; do not speculate.

OUTPUT:
Return ONLY a JSON object with exactly these keys:
{
  "summary": string (<= 600 chars),
  "what_changed": [{ "statement": string (<=600 chars), "classification": "OBSERVED"|"INFERRED"|"UNKNOWN", "evidence": [string] }],
  "endpoint_observations": [{ "endpoint": string, "statement": string, "classification": string, "evidence": [string] }],
  "limitations": [string],
  "confidence_notes": [string]
}
Every evidence[] entry must be copied verbatim from evidence_keys. Statements
failing validation are dropped — an empty output is acceptable when evidence is thin.`;

// --- LLM call --------------------------------------------------------------------

interface LlmRawResponse {
  summary?: unknown;
  what_changed?: unknown;
  endpoint_observations?: unknown;
  limitations?: unknown;
  confidence_notes?: unknown;
}

async function callLlm(evidence: RegressionEvidence): Promise<{ raw: LlmRawResponse; model: string } | null> {
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
                "Explain what changed between the baseline and candidate runs. Use only numbers present in `numbers` and only references present in `evidence_keys`. Do not alter the deterministic object.",
              deterministic_regression: evidence.deterministic,
              policy: evidence.policyDocumentation,
              baseline_evidence: evidence.baselineEvidence,
              candidate_evidence: evidence.candidateEvidence,
              numbers: evidence.numbers,
              evidence_keys: evidence.evidenceKeys,
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

// --- deterministic fallback (restates the engine; derives nothing) ---------------

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : `${Math.round(v * 100) / 100}`;
}

function deterministicRegressionInterpretation(
  evidence: RegressionEvidence,
): LlmRawResponse {
  const d: DeterministicRegressionObject = evidence.deterministic;
  const runB = `run:${d.baselineRunId}`;
  const runC = `run:${d.candidateRunId}`;
  const m = d.metrics;
  const statements: { statement: string; classification: string; evidence: string[] }[] = [];

  if (d.status === "INCONCLUSIVE") {
    statements.push({
      statement: `The regression comparison is INCONCLUSIVE${d.compatibilityReasons.length ? ` (${d.compatibilityReasons.join("; ")})` : ""}; no regression verdict is possible from this evidence.`,
      classification: "UNKNOWN",
      evidence: [`regression:${evidence.regressionId}`, runB, runC],
    });
  } else {
    const changed = (["p50", "p95", "p99", "average", "max", "rps", "errorRate", "totalRequests"] as const)
      .map((k) => [k, m[k]] as const)
      .filter(([, d2]) => d2.absoluteDelta !== null && d2.absoluteDelta !== 0);
    statements.push({
      statement: `Deterministic classification: ${d.status} under policy ${d.policyVersion}.`,
      classification: "OBSERVED",
      evidence: [`regression:${evidence.regressionId}`, `policy:${d.policyVersion}`],
    });
    for (const [name, dd] of changed.slice(0, 5)) {
      const pct = dd.percentageDelta === null ? "" : ` (${dd.percentageDelta > 0 ? "+" : ""}${fmt(dd.percentageDelta)}%)`;
      const unit = name === "errorRate" ? "pp" : "";
      const val = name === "errorRate" ? fmt(dd.absoluteDelta) : fmt(dd.absoluteDelta);
      statements.push({
        statement: `${name} changed by ${val}${unit}${pct} from baseline ${fmt(dd.baseline)} to candidate ${fmt(dd.candidate)}.`,
        classification: "OBSERVED",
        evidence: [`regression.metrics.${name}.absoluteDelta`, runB, runC],
      });
    }
    for (const row of d.endpointResults.slice(0, 4)) {
      if (row.p95.absoluteDelta === null) continue;
      statements.push({
        statement: `The candidate recorded ${row.p95.absoluteDelta >= 0 ? "higher" : "lower"} p95 latency for ${row.endpoint}: ${fmt(row.p95.baseline)}ms → ${fmt(row.p95.candidate)}ms${row.p95.percentageDelta === null ? "" : ` (${row.p95.percentageDelta > 0 ? "+" : ""}${fmt(row.p95.percentageDelta)}%)`}.`,
        classification: "OBSERVED",
        evidence: [`regression.endpoint.${row.endpoint}.p95.absoluteDelta`, `regression.endpoint:${row.endpoint}`],
      });
    }
    for (const change of d.statusDistributionChanges.slice(0, 3)) {
      statements.push({
        statement: `Status distribution changed: ${change}.`,
        classification: "OBSERVED",
        evidence: [runB, runC],
      });
    }
    statements.push({
      statement: `These measurements do not establish why the observed changes occurred.`,
      classification: "UNKNOWN",
      evidence: [`policy:${d.policyVersion}`],
    });
  }

  return {
    summary:
      d.status === "INCONCLUSIVE"
        ? `Regression comparison is INCONCLUSIVE; deterministic engine reported: ${(d.inconclusive?.reasons ?? []).join(", ") || "no reasons recorded"}.`
        : `Deterministic regression engine classified the baseline→candidate change as ${d.status} (policy ${d.policyVersion}). Restated facts only; causes are not established.`,
    what_changed: statements,
    endpoint_observations: [],
    limitations: evidence.limitations,
    confidence_notes: [
      "This interpretation restates the deterministic regression object; it does not re-derive or alter it.",
    ],
  };
}

// --- Convex's optionals: strip explicit nulls before persisting -------------------

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

// --- the action --------------------------------------------------------------------

export const analyzeRegression = internalAction({
  args: { regressionId: v.id("regressionAnalyses") },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    const regression = await ctx.runQuery(internal.regressionDb.getRegressionInternal, {
      regressionId: args.regressionId,
    });
    if (!regression) throw new Error(`regression analysis not found: ${args.regressionId}`);
    const userId: Id<"users"> = regression.userId;

    const baseline = await ctx.runQuery(internal.regressionDb.getRunInternal, {
      runId: regression.baselineRunId,
    });
    const candidate = await ctx.runQuery(internal.regressionDb.getRunInternal, {
      runId: regression.candidateRunId,
    });
    if (!baseline || !candidate) throw new Error("referenced baseline/candidate run missing (runs must never be mutated)");

    // The deterministic object stored on the regression row is authoritative;
    // rebuild evidence from it (recomputed only if absent, e.g. legacy rows).
    const deterministic = regression.deterministic as DeterministicRegressionObject;
    const evidence = buildRegressionEvidence(
      String(args.regressionId),
      baseline,
      candidate,
      deterministic,
    );

    const llm = await callLlm(evidence);
    const raw = llm?.raw ?? deterministicRegressionInterpretation(evidence);
    const validated = validateRegressionAnalysis(raw, evidence);

    // Append-only AI document (subjectKind "regression"), linked to the row.
    const stored = await ctx.runMutation(internal.aiRuntimeDb.storeAnalysis, {
      userId,
      subjectKind: "regression",
      regressionAnalysisId: args.regressionId,
      analyzerKind: llm ? "llm" : "deterministic",
      model: llm?.model,
      promptVersion: REGRESSION_PROMPT_VERSION,
      analysis: stripNulls(validated),
      evidenceRefs: evidence.evidenceKeys.slice(0, 250),
    });

    // Link the latest interpretation onto the regression row (additive only).
    await ctx.runMutation(internal.regressionDb.attachAiAnalysisInternal, {
      regressionId: args.regressionId,
      aiAnalysisId: stored.analysisId,
      aiAnalyzerKind: llm ? "llm" : "deterministic",
      aiGeneratedAt: Date.now(),
      aiAnalysis: stripNulls(validated),
    });

    return stored;
  },
});
