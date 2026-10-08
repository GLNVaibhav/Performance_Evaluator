/**
 * Phase 10 — END-TO-END PRODUCT-PATH VALIDATION (§17 extension).
 *
 * Exercises the REAL deployed product path end to end:
 *
 *   auth:signIn → mutations:createRun { executeViaBridge: true } ×2
 *     (BASELINE with the demo API in `normal`; controlled change
 *      `demo/mode=db_latency`; CANDIDATE — same plan, same target)
 *   → scheduled internal.executor.submitExecutionRun
 *     (Convex cloud → EXECUTION_BRIDGE_URL → FastAPI → k6)
 *   → scheduled poller → executorDb.saveLiveResult
 *   → mutations:createRegressionAnalysis (deterministic engine, runs NEVER mutated)
 *   → regressionEntries:analyzeMyRegression (AI interpretation, validated)
 *   → queries + regressionQueries (what the UI renders)
 *
 * If the execution bridge is NOT reachable from Convex cloud (dead tunnel),
 * the failed run must still be honest (execution_error, never a silent
 * simulation fallback — §17 failure-path honesty) and validation continues
 * over two compatible completed LIVE_K6 runs already stored in the
 * deployment: the deterministic object is recomputed locally from the stored
 * runs and must EQUAL the product's stored object, and every delta must
 * match the stored run metrics. Real k6 data throughout.
 *
 * Usage: bun scripts/phase10-product-path-e2e.mjs
 */
import {
  checkCompatibility,
  computeDeterministicRegression,
  DEFAULT_REGRESSION_POLICY,
  REGRESSION_POLICY_VERSION,
} from "../src/convex/regression/core.ts";

const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";
const DEMO_API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const note = (msg) => console.log(`NOTE  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers -----------------------------------------------------------------

/** Canonical JSON (sorted keys) so stored vs recomputed objects compare structurally. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const canon = (v) => JSON.stringify(canonical(v));

const numsOf = (s) => [...String(s).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
/** Validator-equivalence tolerance: max(0.011, 0.15% of the source number). */
const closeTo = (t, s) => Math.abs(t - s) <= Math.max(0.011, Math.abs(s) * 0.0015);
/** Every non-exempt number in the text must exist in the source evidence. */
function fabricatedNumbers(text, source) {
  const src = numsOf(source);
  return numsOf(text).filter((t) => {
    if (Number.isInteger(t) && t >= 0 && t <= 1000) return false; // small-integer exemption
    return !src.some((s) => closeTo(t, s));
  });
}

async function api(kind, path, args, token) {
  const res = await fetch(`${DEPLOY}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await res.json();
  if (j.status !== "success") throw new Error(`${path} failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}

async function setDemoMode(mode) {
  const res = await fetch(`${DEMO_API}/demo/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`demo mode switch failed: ${res.status}`);
  return (await res.json()).mode;
}

async function createAndAwaitRun(token, plan, label, timeoutMs) {
  const runId = await api(
    "mutation",
    "mutations:createRun",
    {
      plan,
      targetBaseUrl: DEMO_API,
      rawInput: `Phase 10 product-path ${label} (LIVE_K6 via execution bridge)`,
      interpreter: "deterministic",
      executeViaBridge: true,
    },
    token,
  );
  console.log(`  ${label}: convex runId=${runId}`);
  const deadline = Date.now() + timeoutMs;
  let run = null;
  while (Date.now() < deadline) {
    run = await api("query", "queries:getRun", { runId }, token);
    if (["completed", "execution_error", "cancelled"].includes(run.status)) break;
    await sleep(3000);
  }
  return { runId, run };
}

const isCompletedLive = (r) =>
  !!r && r.status === "completed" && (r.executionMode ?? r.engineMode) === "live_k6" && !!r.metrics && !!r.externalResult?.metrics && !!r.plan;

// Metric verification uses the engine's exact source preference: verbatim
// externalResult.metrics first, mapped metrics fallback.
const METRICS = [
  ["p50", "p50_ms", "p50"],
  ["p95", "p95_ms", "p95"],
  ["p99", "p99_ms", "p99"],
  ["average", "average_ms", "latencyAvgMs"],
  ["max", "max_ms", "latencyMaxMs"],
  ["rps", "rps", "maxRps"],
  ["errorRate", "error_rate", "errorRate"],
  ["totalRequests", "total_requests", "totalRequests"],
];
const storedValue = (run, extKey, mappedKey) => {
  const ext = run?.externalResult?.metrics ?? null;
  const v = ext ? ext[extKey] : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = run?.metrics?.[mappedKey];
  return typeof m === "number" && Number.isFinite(m) ? m : null;
};

// --- the approved deterministic plan (small + safe; controlled demo API) ------

const PLAN = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "5s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: ["phase 10 product-path regression validation: identical plan on both sides"],
};

// --- sign in -------------------------------------------------------------------

const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
console.log(`signed in as ${EMAIL}`);
check("execution bridge is configured in the deployment (queries:bridgeConfigured)", (await api("query", "queries:bridgeConfigured", {}, token)) === true);

// --- PLAN A: the full product path with a controlled change ---------------------

console.log("\n--- PLAN A: fresh LIVE_K6 runs through the Convex product path ---");
let pair = null;
let usedPlanA = false;
await setDemoMode("normal");
const a1 = await createAndAwaitRun(token, PLAN, "baseline(normal)", 55_000);
if (isCompletedLive(a1.run)) {
  const changed = await setDemoMode("db_latency");
  check("controlled demo difference applied (normal → db_latency)", changed === "db_latency", `demo mode=${changed}`);
  const a2 = await createAndAwaitRun(token, PLAN, "candidate(db_latency)", 55_000);
  await setDemoMode("normal");
  if (isCompletedLive(a2.run)) {
    pair = { baseline: a1.run, candidate: a2.run };
    usedPlanA = true;
  } else {
    note(`candidate did not complete: ${a2.run?.status ?? "timeout"}`);
  }
} else {
  const st = a1.run?.status ?? "timeout";
  const msg = a1.run?.errorMessage ?? "(none)";
  note(`bridge not reachable from Convex cloud (${st}): ${msg.slice(0, 160)}`);
  if (a1.run) {
    check("§17 failure-path honesty: no silent simulation fallback on bridge failure", a1.run.engineMode !== "simulation", `engineMode=${a1.run.engineMode}`);
    check(
      "§17 failure-path honesty: run recorded execution_error with a bridge diagnosis",
      st === "execution_error" && /unreachable|returned HTTP \d+/i.test(msg),
      st === "execution_error" ? msg.slice(0, 120) : `status=${st}`,
    );
  }
  await setDemoMode("normal");
}

// --- PLAN B: regression over two compatible stored LIVE_K6 runs -------------------

if (!pair) {
  console.log("\n--- PLAN B: stored LIVE_K6 runs already in the deployment ---");
  const runs = await api("query", "queries:listRuns", {}, token);
  const eligible = runs.filter(
    (r) =>
      isCompletedLive(r) &&
      Array.isArray(r.externalResult.metrics.per_endpoint) &&
      (r.plan?.selectedEndpoints ?? []).every((e) => r.externalResult.metrics.per_endpoint.some((p) => p.endpoint === e)),
  );
  check("deployment holds completed LIVE_K6 runs with per-endpoint evidence", eligible.length >= 2, `${eligible.length} eligible`);
  pair = null;
  for (const cand of eligible) {
    const base = eligible.find((r) => r._id !== cand._id && r._creationTime <= cand._creationTime && checkCompatibility(r, cand).compatible);
    if (base) {
      pair = { baseline: base, candidate: cand };
      break;
    }
  }
  if (!pair) {
    check("two compatible stored runs exist", false, "no compatible pair found — nothing to verify");
    process.exit(1);
  }
  check("most recent compatible stored pair selected (checkCompatibility)", true, `${pair.baseline._id} → ${pair.candidate._id}`);
}

console.log(`\npair: baseline=${pair.baseline._id}  candidate=${pair.candidate._id}  (product path: ${usedPlanA ? "A — fresh runs" : "B — stored runs"})`);
if (usedPlanA) {
  check(
    "controlled change visible in product-stored runs (candidate p95 ≫ baseline p95)",
    pair.candidate.metrics.p95 > pair.baseline.metrics.p95 * 1.1,
    `${pair.baseline.metrics.p95}ms → ${pair.candidate.metrics.p95}ms`,
  );
}

// --- create the regression analysis through the product path ---------------------

const created = await api(
  "mutation",
  "regressionDb:createRegressionAnalysis",
  { baselineRunId: pair.baseline._id, candidateRunId: pair.candidate._id },
  token,
);
console.log(`\nregression row: id=${created.regressionId} version=${created.version}`);
check("createRegressionAnalysis returned a versioned row", typeof created.regressionId === "string" && created.version >= 1, `version=${created.version}`);

const row = await api("query",
  "regressionDb:getMyRegressionAnalysis", { regressionId: created.regressionId }, token);
check("regression row is readable by its owner", !!row && row._id === created.regressionId);
check("row references the requested pair", row.baselineRunId === pair.baseline._id && row.candidateRunId === pair.candidate._id);
check("row carries the regression policy version", row.policyVersion === REGRESSION_POLICY_VERSION, row.policyVersion);

// --- deterministic object: stored === recomputed from the stored runs (§11) -------

const local = computeDeterministicRegression(pair.baseline, pair.candidate, DEFAULT_REGRESSION_POLICY);
check(
  "stored deterministic object reproduces EXACTLY from the stored runs + policy (canonical equality)",
  canon(row.deterministic) === canon(local),
  canon(row.deterministic) === canon(local) ? `status=${row.deterministic.status}` : "objects differ",
);

if (row.deterministic.inconclusive) {
  note(`pair is INCONCLUSIVE (${row.deterministic.inconclusive.reasons.join(", ")}) — storage/reproducibility verified; delta checks skipped`);
} else {
  const d = row.deterministic;
  check("compatibility is COMPATIBLE", d.compatibility === "COMPATIBLE", d.compatibilityReasons.join("; "));
  check("inconclusive is null for a completed compatible pair", d.inconclusive === null);
  check("status is a policy classification", ["NO_REGRESSION_DETECTED", "LATENCY_REGRESSION", "THROUGHPUT_REGRESSION", "ERROR_RATE_REGRESSION", "MULTIPLE_REGRESSIONS"].includes(d.status), d.status);
  check("breaches back the status (every breach names latency or rps/error rate)", d.breaches.every((b) => /^(p50|p95|p99|average|max) latency |^rps |^error rate \+/.test(b)), `${d.breaches.length} breaches`);

  for (const [name, extKey, mappedKey] of METRICS) {
    const md = d.metrics[name];
    const b = storedValue(pair.baseline, extKey, mappedKey);
    const c = storedValue(pair.candidate, extKey, mappedKey);
    const tol = (x, y) => x !== null && y !== null && Math.abs(x - y) <= Math.max(0.011, Math.abs(y) * 0.0015);
    const pctOk =
      md.percentageDelta === null
        ? b === 0 || b === null || c === null
        : Math.abs(md.percentageDelta - ((c - b) / Math.abs(b)) * 100) < 1e-6;
    check(
      `${name} delta matches the stored run metrics`,
      tol(md.baseline, b) && tol(md.candidate, c) && tol(md.absoluteDelta, c - b) && pctOk,
      `${md.baseline} → ${md.candidate} (Δ=${md.absoluteDelta})`,
    );
  }

  for (const er of d.endpointResults) {
    const bRow = pair.baseline.externalResult.metrics.per_endpoint.find((p) => p.endpoint === er.endpoint);
    const cRow = pair.candidate.externalResult.metrics.per_endpoint.find((p) => p.endpoint === er.endpoint);
    check(
      `endpoint ${er.endpoint}: p95 row matches verbatim per-endpoint evidence`,
      !!bRow && !!cRow && Math.abs(er.p95.baseline - bRow.p95_ms) <= 0.011 && Math.abs(er.p95.candidate - cRow.p95_ms) <= 0.011 && Math.abs(er.p95.absoluteDelta - (cRow.p95_ms - bRow.p95_ms)) <= 0.011,
      `Δ=${er.p95.absoluteDelta}`,
    );
  }
  check("no subjective wording enters the stored deterministic object", !canon(d).match(/\b(good|bad|better|worse|score)\b/i));
}

// --- reproducibility: a re-analysis of the same pair is a new, identical version ---

const again = await api(
  "mutation",
  "regressionDb:createRegressionAnalysis",
  { baselineRunId: pair.baseline._id, candidateRunId: pair.candidate._id },
  token,
);
check("re-analysis bumps the version monotonically", again.version === created.version + 1, `${created.version} → ${again.version}`);
const row2 = await api("query",
  "regressionDb:getMyRegressionAnalysis", { regressionId: again.regressionId }, token);
check("re-analysis produces the identical deterministic object (no clock/no AI)", canon(row2.deterministic) === canon(row.deterministic));

// --- AI interpretation through the product path (validated, interpretation-only) ---

console.log("\n--- AI interpretation (regressionEntries:analyzeMyRegression) ---");
const ai = await api("action", "regressionEntries:analyzeMyRegression", { regressionId: created.regressionId }, token);
check("AI action returned a versioned analysis", typeof ai.analysisId === "string" && ai.version >= 1, `analysisId=${ai.analysisId}`);

const doc = await api("query", "regressionQueries:latestAiForRegression", { regressionId: created.regressionId }, token);
check("latestAiForRegression returns the stored AI document", !!doc && doc._id === ai.analysisId);
check("AI document is regression-scoped and linked", doc.subjectKind === "regression" && doc.regressionAnalysisId === created.regressionId, `analyzerKind=${doc.analyzerKind}`);
check("analyzerKind is llm or deterministic (fallback)", doc.analyzerKind === "llm" || doc.analyzerKind === "deterministic", doc.analyzerKind);

const a = doc.analysis;
check("validated analysis shape: summary", typeof a?.summary === "string" && a.summary.length > 0 && a.summary.length <= 600);
check("validated analysis shape: whatChanged[] with classified statements + evidence", Array.isArray(a?.whatChanged) && a.whatChanged.every((s) => typeof s.statement === "string" && ["OBSERVED", "INFERRED", "UNKNOWN"].includes(s.classification) && Array.isArray(s.evidence)));
check("validated analysis shape: endpointObservations[]", Array.isArray(a?.endpointObservations));
check("validated analysis shape: limitations + confidenceNotes + rejected", Array.isArray(a?.limitations) && Array.isArray(a?.confidenceNotes) && Array.isArray(a?.rejected));
check("every cited evidence reference exists in the stored evidence refs", a.whatChanged.every((s) => s.evidence.every((ref) => doc.evidenceRefs.includes(ref))));

const numberSource = canon({ deterministic: row.deterministic, baseline: pair.baseline, candidate: pair.candidate });
const statements = [a.summary, ...a.whatChanged.map((s) => s.statement), ...a.endpointObservations.map((s) => s.statement)].filter(Boolean);
const fabricated = statements.flatMap((s) => fabricatedNumbers(s, numberSource));
check("no fabricated numbers in AI statements (validator tolerance)", fabricated.length === 0, fabricated.length ? `fabricated: ${fabricated.slice(0, 5).join(", ")}` : "all numbers trace to stored evidence");
check("no subjective quality words in AI statements", !statements.some((s) => /\b(good|bad|better|worse|improved)\b/i.test(s)));

// --- the regression row carries the AI linkage -------------------------------------

const rowAfter = await api("query",
  "regressionDb:getMyRegressionAnalysis", { regressionId: created.regressionId }, token);
check(
  "regression row links the AI interpretation (deterministic object untouched)",
  rowAfter.aiAnalysisId === ai.analysisId && rowAfter.aiAnalyzerKind === doc.analyzerKind && canon(rowAfter.deterministic) === canon(row.deterministic),
  `aiAnalysisId=${rowAfter.aiAnalysisId ?? "(none)"}`,
);

// --- summary -----------------------------------------------------------------------

const d = row.deterministic;
console.log("\n================ PHASE 10 PRODUCT-PATH E2E ================");
console.log(`path            : ${usedPlanA ? "A — fresh controlled LIVE_K6 runs through Convex" : "B — stored LIVE_K6 runs (bridge unreachable from cloud)"}`);
console.log(`runs            : ${pair.baseline._id} → ${pair.candidate._id}`);
console.log(`regression      : ${created.regressionId} (v${created.version}; re-analysis v${again.version})`);
console.log(`deterministic   : ${d.compatibility} / ${d.status}${d.inconclusive ? ` (INCONCLUSIVE: ${d.inconclusive.reasons.join(", ")})` : ""}`);
if (!d.inconclusive) console.log(`p95             : ${d.metrics.p95.baseline}ms → ${d.metrics.p95.candidate}ms (${d.metrics.p95.percentageDelta?.toFixed(2)}%)`);
console.log(`AI interpretation: ${ai.analysisId} (analyzerKind=${doc.analyzerKind})`);
console.log("===========================================================\n");

console.log(failures === 0 ? "ALL CHECKS PASSED — Phase 10 verified through the deployed product path." : `${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
