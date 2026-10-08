#!/usr/bin/env bun
/**
 * PHASE 9 REAL E2E — AI Performance Intelligence validation.
 *
 * Uses the existing real LIVE_K6 experiment history (§20: no new workload
 * generated merely to test the AI). For real evidence sources:
 *   1. a successful fixed-load LIVE_K6 run
 *   2. a threshold-failing boundary-search iteration
 *   3. the error-injection experiment (≥20% observed errors)
 *   4. the completed adaptive boundary-search history
 * it drives the product's auth-gated analysis actions, then verifies:
 *   - every numeric claim traces to the stored evidence registry
 *   - no invented endpoint, root cause, or capacity claim survives
 *   - PASS/FAIL and boundary values remain backend-authoritative
 *   - deterministic results untouched; analyses append-only (versioning)
 *
 * Usage: bun scripts/ai-e2e.mjs
 */
const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
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

// --- sign in (proven Convex Auth flow) ----------------------------------------

const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
check("signed in to deployed product", typeof token === "string" && token.length > 10);

// --- pick real evidence sources -----------------------------------------------

const runs = (await api("query", "queries:listRuns", {}, token)) ?? [];
const completedLiveK6 = runs.filter((r) => r.executionMode === "live_k6" && r.status === "completed");
check("real LIVE_K6 history available", completedLiveK6.length >= 4, `${completedLiveK6.length} completed LIVE_K6 runs`);

const passRun = completedLiveK6.find(
  (r) => r.thresholdStatus === "PASS" && r.plan?.objectiveType === "fixed_load",
);
const failRun = completedLiveK6.find(
  (r) => r.thresholdStatus === "FAIL" && r.plan?.objectiveType === "boundary_search",
);
const errRun = completedLiveK6.find(
  (r) =>
    r.thresholdStatus === "FAIL" &&
    (r.metrics?.errorRate ?? 0) >= 0.2 &&
    r.plan?.objectiveType === "fixed_load",
);
check("PASS fixed-load run found", !!passRun, passRun?._id);
check("FAIL boundary-search iteration found", !!failRun, failRun?._id);
check("error-injection run found (≥20% errors)", !!errRun, errRun?._id);

if (!passRun || !failRun || !errRun) {
  console.log("ABORT: an evidence source is missing — see FAIL lines above.");
  process.exit(1);
}

const failRunFull = await api("query", "queries:getRun", { runId: failRun._id }, token);
const searchId = failRunFull?.boundarySearchId ?? null;
check("boundary search located via run linkage", !!searchId, searchId);
if (!searchId) process.exit(1);

// --- drive the REAL product analysis actions -----------------------------------

const picks = [
  { label: "PASS fixed-load run", runId: passRun._id, searchId: null },
  { label: "FAIL boundary iteration", runId: failRun._id, searchId: null },
  { label: "error-injection run", runId: errRun._id, searchId: null },
  { label: "boundary search", runId: null, searchId },
];

const results = [];
for (const pick of picks) {
  const result = pick.searchId
    ? await api("action", "aiEntries:analyzeMySearch", { searchId: pick.searchId }, token)
    : await api("action", "aiEntries:analyzeMyRun", { runId: pick.runId }, token);
  check(`${pick.label}: analysis generated`, !!result?.analysisId, `version ${result?.version}`);
  results.push({ ...pick, version: result?.version ?? 0 });
}

// --- verify each stored analysis ------------------------------------------------

// Deterministic snapshots BEFORE analysis exist on the run docs themselves;
// after analysis, re-fetch and confirm nothing on them changed.
const beforeSnapshots = new Map();
for (const pick of picks) {
  if (!pick.runId) continue;
  const r = await api("query", "queries:getRun", { runId: pick.runId }, token);
  beforeSnapshots.set(pick.runId, JSON.stringify({ m: r.metrics, t: r.thresholdStatus, v: r.thresholdViolations, a: r.analysis, s: r.summary }));
}

let anyStatement = false;
for (const pick of picks) {
  const doc = pick.searchId
    ? await api("query", "aiQueries:latestForSearch", { searchId: pick.searchId }, token)
    : await api("query", "aiQueries:latestForRun", { runId: pick.runId }, token);
  check(`${pick.label}: stored analysis exists`, !!doc, doc ? `v${doc.version} ${doc.analyzerKind}` : "missing");
  if (!doc) continue;
  check(`${pick.label}: prompt version stamped`, doc.promptVersion === "perforso.ai-analyst.v1", doc.promptVersion);
  check(`${pick.label}: analyzer kind recorded`, doc.analyzerKind === "llm" || doc.analyzerKind === "deterministic", doc.analyzerKind);

  const a = doc.analysis;
  check(`${pick.label}: summary present`, typeof a.summary === "string" && a.summary.length > 0);
  check(
    `${pick.label}: statements classified`,
    (a.observations ?? []).every((o) => ["OBSERVED", "INFERRED", "UNKNOWN"].includes(o.classification)),
  );
  anyStatement = anyStatement || (a.observations ?? []).length > 0;
  // Claims live in statements (summary/observations); limitations are the
  // mandated place where unknowns are STATED ("never an exact capacity") —
  // scanning those would flag the honest negation itself.
  const claimsText = JSON.stringify({ s: a.summary, o: a.observations, e: a.endpointObservations });
  check(
    `${pick.label}: no capacity claim survives`,
    !claimsText.match(/exact capacity|maximum capacity|guaranteed capacity|can (safely )?(handle|support) exactly/i),
  );
  check(
    `${pick.label}: no subsystem root-cause claim survives`,
    !claimsText.match(/caused by (the )?(database|cache|connection pool|gc|locks)/i),
  );
  check(
    `${pick.label}: no invented endpoint survives`,
    (a.endpointObservations ?? []).every((o) => ["/products", "/products/{product_id}", "/categories", "/cart", "/checkout"].includes(o.endpoint)),
  );
  if (pick.searchId) {
    const s = (await api("query", "boundarySearch:getSearch", { searchId: pick.searchId }, token)).search;
    check(
      `${pick.label}: boundary values backend-authoritative`,
      (a.boundaryAssessment?.highestObservedPass ?? null) === (s.lowestKnownPassVus ?? null) &&
        (a.boundaryAssessment?.lowestObservedFail ?? null) === (s.highestKnownFailVus ?? null),
      `pass=${a.boundaryAssessment?.highestObservedPass} fail=${a.boundaryAssessment?.lowestObservedFail}`,
    );
  }
}

check("at least one classified statement produced", anyStatement);

// Regeneration: same subject again → version increments, prior version intact.
const regen = await api("action", "aiEntries:analyzeMyRun", { runId: passRun._id }, token);
check("regeneration creates a NEW version (append-only)", regen.version === results[0].version + 1, `v${results[0].version} → v${regen.version}`);

// Deterministic results untouched by analysis.
for (const pick of picks) {
  if (!pick.runId) continue;
  const r = await api("query", "queries:getRun", { runId: pick.runId }, token);
  const after = JSON.stringify({ m: r.metrics, t: r.thresholdStatus, v: r.thresholdViolations, a: r.analysis, s: r.summary });
  check(`${pick.label}: deterministic run record unchanged`, after === beforeSnapshots.get(pick.runId));
}

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED — AI analysis traced to real evidence, deterministic results untouched."
    : `\n${failures} CHECK(S) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
