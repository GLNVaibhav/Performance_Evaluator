# Phase 10 — Performance Regression Intelligence — Final Report (§20)

**Project:** Perforso · **Deployment:** `brilliant-mastiff-710.convex.cloud` (Freebuff Cloud)
**Scope:** Deterministic comparison of two compatible LIVE_K6 runs (BASELINE vs CANDIDATE). The AI layer sits strictly downstream and is interpretation-only. No simulation, probe, or boundary-search data ever enters a regression verdict.

---

## 1. Compatibility Model (§2)

`checkCompatibility` (`src/convex/regression/core.ts`) compares every dimension of the two runs and reports **every** mismatch — nothing is silently compared:

- target base URL (trailing-slash-insensitive, matching the safety gate's normalization)
- execution mode (`executionMode`, fallback `engineMode`) — live-vs-live only in practice; simulation/probe/pending runs are separately made INCONCLUSIVE (§7)
- objective type, test type
- selected endpoints — **set equality** (order-insensitive)
- endpoint weights — exact map equality when either side declares any
- target VUs — integer equality
- duration — strict parser (`ms|s|m|h`) for fixed_load; ramp+hold exact for boundary_search; unparseable ≠ absent (never guessed equal)
- thresholds — exact (`p95LatencyMs`/`errorRate`)

**Load-sensitivity exception:** when the ONLY mismatch is target VUs (with equal execution mode), the comparison is labeled `load_sensitivity_comparison` — a valid comparison kind, not garbage (§2), but still INCONCLUSIVE for regression verdicts because the delta confounds load with behavior.

## 2. Policy (§6)

`REGRESSION_POLICY_VERSION = "perforso.regression-policy.v1"`. `DEFAULT_REGRESSION_POLICY` (documented in `POLICY_DOCUMENTATION`, rendered in evidence/UI; configuration, not hard-coding):

| Rule | Semantics |
|---|---|
| Latency | any of p50/p95/p99/average/max rises by **more than +10%** of the baseline (relative, strictly-beyond) |
| Throughput | rps falls by **more than −10%** (relative, strictly-beyond, requires negative delta) |
| Error rate | rises by **more than +1 percentage point** — **absolute pp, never relative %** (1% → 2% = +1pp: not a regression; 0% → 3% = +3pp: regression) |

Notes: strictly-beyond boundary (exactly at threshold does NOT fire); zero/missing baselines yield `null` percentages (absolute delta stays factual); classifications are factual threshold outcomes — the words good/bad/better/worse appear nowhere.

## 3. Metric Functions (§3)

`extractMetric` reads **exact stored source values** — verbatim `externalResult.metrics` first (`p50_ms`, `p95_ms`, `p99_ms`, `average_ms`, `max_ms`, `rps`, `error_rate`, `total_requests`, `failed_requests`), mapped `metrics` as fallback (`p50`, `p95`, `p99`, `latencyAvgMs`, `latencyMaxMs`, `maxRps`, `errorRate`, `totalRequests`); per-endpoint rows and status codes come **only** from the verbatim layer. Nothing is recomputed from samples.

`delta()` produces `{baseline, candidate, absoluteDelta = candidate − baseline, percentageDelta = (c−b)/|b|×100, baselineSource, candidateSource}`; percentage is `null` for zero/missing baselines. `classifyFromDeltas` implements the §2 policy table. No rounding anywhere in the engine — rounding is presentation and would break reproducibility.

## 4. Endpoint Comparison (§4–§5)

`compareEndpoints`: rows for every endpoint present in **both** runs (`requests, p50, p95, p99, average, max, rps, errorRate` each with absolute+percentage deltas), plus both sides' verbatim status-code distributions. Single-sided endpoints are never compared — they surface as `insufficient_endpoint_overlap`. `statusDistributionChanges` reports, factually: codes that appeared, disappeared, or changed count. Per-endpoint status splits are proportional-split derivation, so they are not fabricated; single-endpoint runs use the run-level distribution as the identity.

## 5. Baseline / Candidate Model

A regression is always **ordered pair** (baseline, candidate) of two **immutable** run documents. The engine reads only the two runs + the policy — no clock, no randomness, no AI — so the object is reproducible from stored runs + policy alone (§11; proven exactly in §10 below). Runs are never mutated by any Phase 10 code path.

## 6. Storage

- `regressionAnalyses` table: `{userId, baselineRunId, candidateRunId, version, policyVersion, createdAt, deterministic, aiAnalysisId?, aiAnalyzerKind?, aiGeneratedAt?, aiAnalysis?}` with indexes `baselineRunId`, `candidateRunId`, `userId`.
- Versioning is monotonic per (baseline, candidate) pair; a re-analysis is a **new row** (append-only).
- AI linkage is a **narrow additive patch** (`attachAiAnalysisInternal`) — deterministic object, run references, and versions untouched.
- `aiAnalyses` gained `regressionAnalysisId: v.optional(v.id("regressionAnalyses"))` + `regressionAnalysisId` index; `subjectKind` now includes `"regression"`.
- **Schema fix found by E2E:** `aiAnalyses.analysis` was a rigid Phase 9 object (required `observations`/`thresholdAssessment`/`boundaryAssessment`), which made regression-shaped analyses **unstoriable** — the deployed analyst action failed with "missing the required field `boundaryAssessment`". Fixed by widening `analysis` to a discriminated union of the two validated shapes (Phase 9 run/boundary shape ∪ Phase 10 regression shape `whatChanged`+`endpointObservations`). Existing Phase 9 rows validate against the first union member unchanged.

## 7. UI

`/app/regression` (`src/pages/Regression.tsx`, route + nav added): run pickers (eligible = completed + live_k6 + metrics), one-click comparison creation, history list, and a detail view with three tagged sections:

- **MEASURED** (sky) — baseline/candidate summary cards, compatibility badge + reasons, load-sensitivity badge.
- **DETERMINISTIC ANALYSIS** (emerald) — inconclusive panel (reasons + detail), breaches panel, `Metric | Baseline | Candidate | Δ | Δ%` table (errorRate rendered ×100 with the `pp` unit), endpoint rows with status-distribution changes, run-level status changes.
- **AI INTERPRETATION** (violet) — generate/regenerate via the auth-gated action; statements carry OBSERVED/INFERRED/UNKNOWN badges, evidence references, and the validator's rejected-claims list.

## 8. AI Integration (interpretation-only, §12–§13)

`regressionAnalyst.ts` ("use node"): reads the **stored** deterministic object (authoritative), merges both runs' Phase 9 evidence registries with regression-scoped keys (`regression.metrics.<name>.absoluteDelta|percentageDelta`, `regression.endpoint.<ep>.p95.absoluteDelta`, `regression:<id>`, `policy:<v>`, `classification:<status>`) → `buildRegressionEvidence`; calls the LLM (temp 0, JSON mode; `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`) with the restatement-only system prompt; validates with `validateRegressionAnalysis`; stores append-only via `aiRuntimeDb.storeAnalysis` (`subjectKind: "regression"`); links the latest interpretation onto the row. On missing key/model/validation failure a **deterministic fallback** (pure restatement of the object) is stored with `analyzerKind: "deterministic"` — the feature never blocks on the AI.

`validateRegressionAnalysis` rejects: fabricated numbers (registry tolerance max(0.011, 0.15%); ≤1000 integers exempt as counts/codes), nonexistent endpoints, root-cause claims ("the database caused…", "CPU regression explains…"), subjective quality words, classification/compatibility overrides (restating the deterministic status is allowed), and OBSERVED statements without valid evidence references. Rejected claims are recorded with reasons — never silently dropped.

## 9. Tests

`src/convex/regression/core.test.ts` — 32 tests: §16 cases 1–20 (identical runs → `NO_REGRESSION_DETECTED` with zero deltas; +50% → `LATENCY_REGRESSION`; negative delta → no "improvement" verdict; 8.4→12.1 = +3.7ms/+44.0476%; zero baseline → null percentage; 0→3% errorRate + 503 appearing → `ERROR_RATE_REGRESSION` + status change; RPS −25% → `THROUGHPUT_REGRESSION`; per-endpoint rows; incompatible target; VU mismatch → `load_sensitivity_comparison`; duration mismatch; endpoint-set mismatch; missing metrics; execution_error; simulation; real-probe; threshold semantics — +8% under 10% no, +10% exactly no, +10.01% yes, custom 5% policy fires at +8%; `MULTIPLE_REGRESSIONS` at 3+ breaches; missing runs) + source-preference/single-sided skip + JSON-equality reproducibility + AI cases 21–25 (valid interpretation passes with 0 rejected; fabricated 1500.5 rejected while small integers are exempt; fabricated endpoint; both root-cause phrasings rejected; status override rejected; restating the deterministic status allowed; quality words rejected) + policy internals (1%→2% = +1pp exactly = NOT a regression; missing values never fire).

**Full suite: 157 tests / 7 files / 0 fail** (125 before Phase 10). `bun tsc -b --noEmit` clean. Convex functions + schema pushed (`bun convex dev --once`).

## 10. Real Validation (§17)

**(a) Local controlled-change validation — `scripts/phase10-regression-validation.mjs` — ALL 15 CHECKS PASSED.**
Real k6 through the authenticated execution plane (bridge token injected from the Convex deployment env into the process env; never printed). Fixed plan: 5 VUs / 8s / `/products` / thresholds {2000ms, 0.5} on the controlled demo API.

- BASELINE (`demo/mode=normal`): externalRunId `14f9c6dc6e18417d9c46bf4d962f0373` — p95 1.4684 ms, avg 1.1331 ms, 9.93 rps, err 0.00%
- controlled change: `demo/mode=db_latency` (the single §17 difference)
- CANDIDATE (identical plan): externalRunId `4d63ee59bd0a4fc0befeb369311956fc` — p95 152.2680 ms, avg 151.5583 ms, 5.76 rps, err 0.00%
- classification: **`MULTIPLE_REGRESSIONS`** — all five latency metrics breach +10% (p95 +10269.61%) **and** rps −41.93% breaches −10%. In a closed fixed-VU workload, added per-request latency necessarily reduces completed requests/sec: the throughput breach is the honest policy-derived consequence of the one controlled change, and the engine claiming it is correct behavior (verified: breach set is exactly the 5 latency metrics + rps; error rate correctly silent at 0→0).
- Verified: every reported delta equals the stored metrics (tolerance max(0.011, 0.15%)); p95 percentage matches stored metrics exactly; endpoint row matches verbatim per-endpoint evidence; no subjective wording in the object; compatibility COMPATIBLE.

**(b) Product-path E2E — `scripts/phase10-product-path-e2e.mjs` — ALL 38 CHECKS PASSED** (through the deployed Convex product path, `auth:signIn` → public mutations/queries/actions):

- **Plan A (fresh runs):** `mutations:createRun {executeViaBridge:true}` from Convex cloud → `execution backend unreachable: fetch failed (LIVE_K6 unavailable — no simulation fallback)` → run honestly `execution_error`. This verified the §17 failure-path honesty requirement: **no silent simulation fallback when the execution plane is unreachable** (the deployment's `EXECUTION_BRIDGE_URL` points at an expired ephemeral trycloudflare tunnel — infrastructure, not product, and exactly the condition the no-fallback rule exists for).
- **Plan B (stored runs):** the two most recent compatible completed LIVE_K6 runs in the deployment were compared: baseline `k17dx1dxstztb8c2jb639k062n8f65vy` → candidate `k17dvgjm5m1v5j2qmd516abvvd8f7703` (real k6 data, ~5.5k requests each).
- `regressionDb:createRegressionAnalysis` stored row `kn7fqypmp954wnqm1hcgays66h8f9jre` (v1; re-analysis bumped to v2 in the first pass, v3/v4 in the final pass).
- **Stored-vs-recomputed proof:** the locally recomputed deterministic object from the stored runs + policy is **canonically identical** (sorted-key JSON equality) to the product-stored object — reproducibility holds in production, not only in unit tests.
- All 8 metric deltas verified against the stored run metrics: p50 20.812232 → 37.2605925 (+16.4483605 ms), p95 111.1086315 → 152.16626525 (+41.05763375 ms, **+36.95%**), p99 137.1521448 → 173.1465158 (+35.994371 ms), average 33.7936150 → 49.4231486 (+15.6295336 ms), max 167.045362 → 268.608371 (+101.563009 ms), rps 1053.5789206 → 984.8498324 (−68.7290882, −6.52% — below the −10% threshold, correctly no breach), errorRate 0 → 0, totalRequests 5471 → 5206 (−265).
- Classification **`LATENCY_REGRESSION`** (5 latency breaches; no throughput/error breach — exactly as the policy dictates), compatibility COMPATIBLE, endpoint `/products` row matches verbatim per-endpoint evidence, re-analysis produces the byte-identical object (no clock, no AI), no subjective wording.

## 11. Evidence

Evidence registries from Phase 9 (both runs) are merged with regression-scoped keys and passed to the AI with the deterministic object, policy documentation, and the numeric registry; `evidenceRefs` (≤250) stored on the AI document give per-statement traceability. The E2E verified that every cited reference in the stored interpretation exists in the stored evidence refs, and that every number in AI statements traces to stored evidence under the validator tolerance.

## 12. Classifications (detected)

- Local §17 controlled change: **`MULTIPLE_REGRESSIONS`** — 5 latency breaches + closed-model throughput consequence; error rate silent.
- Product-path stored pair: **`LATENCY_REGRESSION`** — p95 +36.95% (and p50/p99/avg/max) beyond +10%; rps −6.52% below the −10% threshold → no throughput claim; error rate 0→0 → no error claim.
- Negative deltas never yield "improvement" verdicts (§6 factual language); boundary-equal deltas never fire (strictly-beyond).

## 13. AI Interpretation (production run)

`regressionEntries:analyzeMyRegression` on row `kn7fqypmp954wnqm1hcgays66h8f9jre` → analysis `kh705xq3xttvkanbhv8axdfdes8f9qnd`, `analyzerKind: llm`, model `openai/gpt-4o-mini`, `promptVersion: perforso.regression-analyst.v1`:

- summary restates the deterministic classification verbatim ("Deterministic regression analysis: latency regression; policy perforso.regression-policy.v1.")
- endpoint observations restate exact stored numbers ("p95 increased from 111.1086315ms to 152.16626524999998ms" — OBSERVED, evidence-referenced)
- **8 claims rejected** by the validator (recorded with reasons) — the anti-fabrication/anti-cause discipline works against a real model in production
- E2E checks: validated shape (`whatChanged`/`endpointObservations`/`limitations`/`confidenceNotes`/`rejected`), evidence refs valid, no fabricated numbers, no quality words, row linkage with deterministic object untouched.

## 14. Limitations

1. **Bridge reachability from Convex cloud:** the deployment's `EXECUTION_BRIDGE_URL` targets an expired ephemeral trycloudflare tunnel, so fresh cloud-initiated LIVE_K6 runs fail honestly (`execution_error`, never fallback). A stable tunnel/ingress restores Plan A; the product code needs no change. Local §17 (a) covered the full live path end-to-end.
2. `EXECUTION_BRIDGE_TOKEN` lives in the backend/Convex deployment env, not workspace env; local harnesses read it from `bun convex env list` (names verified; values injected, never printed).
3. Comparison requires the verbatim layer for per-endpoint/status evidence; mapped-metrics-only runs compare at the totals level and lose status-distribution detail (by design — no derivation).
4. The deterministic object is ground truth only for what the two runs measured; it cannot attribute causes (that is the AI layer's prohibition, not an oversight).
5. Boundary-search runs are compared only when ramp/hold are exactly equal; VU-mismatch-only pairs are load-sensitivity comparisons and always INCONCLUSIVE for verdicts.

## 15. Next Phase

Phase 11 candidates: (1) persistent ingress for the execution plane (stable tunnel or hosted bridge) so cloud-initiated LIVE_K6 works from anywhere; (2) scheduled regression watch (compare each new completed run against a pinned baseline run, notify on classification change); (3) policy management UI (per-project threshold overrides + versioned policy history); (4) regression export (JSON/CSV of the deterministic object for CI gating); (5) baseline pinning ("promote this run to the team baseline") with approval gating consistent with the run workflow.

---

**Artifacts:** `src/convex/regression/{core,aiEvidence,aiValidate}.ts` · `src/convex/{regressionDb,regressionAnalyst,regressionEntries,regressionQueries}.ts` · `src/convex/schema.ts` · `src/convex/aiRuntimeDb.ts` · `src/pages/Regression.tsx` (+ route/nav) · `src/convex/regression/core.test.ts` · `scripts/phase10-regression-validation.mjs` · `scripts/phase10-product-path-e2e.mjs`
**Verification:** `bun test` 157/157 · `bun tsc -b --noEmit` clean · schema/functions pushed · §17 (a) 15/15 · §17 (b) 38/38
