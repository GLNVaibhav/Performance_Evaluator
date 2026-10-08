/**
 * PERFORMANCE REGRESSION INTELLIGENCE — AI EVIDENCE BUILDER (Phase 10).
 *
 * Builds the evidence object the regression analyst LLM receives: the
 * deterministic regression object (verbatim), the policy, plus the FULL
 * Phase 9 run evidence of both runs (including their numeric registries).
 * The combined registry is what statement validation enforces — the AI may
 * only cite numbers that exist here, so it cannot fabricate a measurement.
 *
 * Downstream of the deterministic engine (core.ts), upstream of the LLM.
 * This module never modifies a metric, a classification, or a run.
 */
import type { DeterministicRegressionObject, RegressionPolicy } from "./core";
import { REGRESSION_POLICY_VERSION, POLICY_DOCUMENTATION } from "./core";
import { buildRunEvidence } from "../ai/evidence";

export const REGRESSION_PROMPT_VERSION = "perforso.regression-analyst.v1";

export interface RegressionEvidence {
  subject: "regression";
  regressionId: string;
  deterministic: DeterministicRegressionObject;
  policyDocumentation: typeof POLICY_DOCUMENTATION;
  baselineEvidence: ReturnType<typeof buildRunEvidence>;
  candidateEvidence: ReturnType<typeof buildRunEvidence>;
  /** Combined numeric registry: baseline ∪ candidate ∪ deterministic deltas. */
  numbers: Record<string, number>;
  /** All valid evidence references (both runs' keys + regression-scoped keys). */
  evidenceKeys: string[];
  limitations: string[];
}

/**
 * Merge the two runs' registries and add regression-scoped numeric keys
 * (`regression.metrics.p95.absoluteDelta`, …) for every deterministic delta.
 * A delta value is a DERIVED fact produced by this engine, not by the AI —
 * registering it lets the AI restate the engine's numbers verbatim.
 */
export function buildRegressionEvidence(
  regressionId: string,
  baselineRun: unknown,
  candidateRun: unknown,
  deterministic: DeterministicRegressionObject,
  baselineEvidence = buildRunEvidence(baselineRun),
  candidateEvidence = buildRunEvidence(candidateRun),
): RegressionEvidence {
  const numbers: Record<string, number> = {
    ...baselineEvidence.numbers,
    ...candidateEvidence.numbers,
  };
  const keys = new Set<string>([...baselineEvidence.evidenceKeys, ...candidateEvidence.evidenceKeys]);

  keys.add(`regression:${regressionId}`);
  keys.add(`run:${deterministic.baselineRunId}`);
  keys.add(`run:${deterministic.candidateRunId}`);
  keys.add(`policy:${deterministic.policyVersion}`);
  keys.add(`classification:${deterministic.status}`);

  const deltaKeys: [string, { absoluteDelta: number | null; percentageDelta: number | null }][] = [
    ["p50", deterministic.metrics.p50],
    ["p95", deterministic.metrics.p95],
    ["p99", deterministic.metrics.p99],
    ["average", deterministic.metrics.average],
    ["max", deterministic.metrics.max],
    ["rps", deterministic.metrics.rps],
    ["errorRatePp", deterministic.metrics.errorRate],
    ["totalRequests", deterministic.metrics.totalRequests],
  ];
  for (const [name, d] of deltaKeys) {
    if (d.absoluteDelta !== null) {
      const k = `regression.metrics.${name}.absoluteDelta`;
      numbers[k] = d.absoluteDelta;
      keys.add(k);
    }
    if (d.percentageDelta !== null) {
      const k = `regression.metrics.${name}.percentageDelta`;
      numbers[k] = d.percentageDelta;
      keys.add(k);
    }
  }
  deterministic.endpointResults.forEach((row, i) => {
    keys.add(`regression.endpoint:${row.endpoint}`);
    const add = (n: number | null, suffix: string) => {
      if (n === null) return;
      const k = `regression.endpoint.${row.endpoint}.${suffix}`;
      numbers[k] = n;
      keys.add(k);
    };
    add(row.p95.absoluteDelta, "p95.absoluteDelta");
    add(row.p95.percentageDelta, "p95.percentageDelta");
    add(row.p50.absoluteDelta, "p50.absoluteDelta");
    add(row.p99.absoluteDelta, "p99.absoluteDelta");
    add(row.average.absoluteDelta, "average.absoluteDelta");
    add(row.errorRate.absoluteDelta, "errorRate.absoluteDelta");
    add(row.requests.absoluteDelta, "requests.absoluteDelta");
    void i;
  });

  const limitations = [
    ...new Set([
      "The regression metrics, deltas, and classifications in `deterministic` were computed by a deterministic engine from stored run measurements — restate them, never alter or re-derive them.",
      "A deterministic delta is a factual difference between two measurements, not a quality judgment: the words good/bad/better/worse do not apply.",
      ...baselineEvidence.limitations,
      ...candidateEvidence.limitations,
      ...(deterministic.status === "INCONCLUSIVE"
        ? ["The comparison is INCONCLUSIVE; the reasons are listed in `deterministic.inconclusive`. Do not speculate about causes."]
        : []),
    ]),
  ];

  return {
    subject: "regression",
    regressionId,
    deterministic,
    policyDocumentation: POLICY_DOCUMENTATION,
    baselineEvidence,
    candidateEvidence,
    numbers,
    evidenceKeys: Array.from(keys),
    limitations,
  };
}

// Type-only re-exports keep the analyst imports honest.
export type { RegressionPolicy };
export { REGRESSION_POLICY_VERSION };
