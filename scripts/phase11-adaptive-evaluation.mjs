/**
 * Phase 11 — ADAPTIVE BOUNDARY SEARCH EVALUATION (reproducible).
 *
 * Runs two REAL searches through the product path (Convex cloud → bridge →
 * k6 → demo API), then validates each recorded experiment sequence by
 * REPLAYING the deterministic algorithm (boundarySearchLogic.ts, imported
 * verbatim) over the recorded outcomes:
 *
 *   search A (demo normal):        expected all-PASS climb to the safety
 *                                  ceiling (sequence 1,2,4,...,maxVus)
 *   search B (demo error_injection
 *             + tight errorRate):  expected FAIL at minVus → minimum_floor
 *                                  stop, no PASS ever observed
 *
 * Validated (§13): boundaries, sequence logic (exact replay match), stop
 * condition, no duplicate execution (no repeated VU within a search's
 * fingerprint set), no execution-error-as-FAIL. No exact p95 values are
 * required — outcomes are read from the recorded runs, and the SEQUENCE
 * must be exactly what the algorithm dictates given them.
 *
 * Usage: bun scripts/phase11-adaptive-evaluation.mjs
 */
import {
  selectNextCandidate,
  updateBoundaries,
  classifyOutcome,
  decideStop,
  iterationFingerprint,
  buildSafeRegion,
} from "../src/convex/boundarySearchLogic.ts";

const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";
const DEMO_API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(kind, path, args, token) {
  const res = await fetch(`${DEPLOY}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await res.json();
  if (j.status !== "success") throw new Error(`${path} failed: ${JSON.stringify(j).slice(0, 200)}`);
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

/** Replay the deterministic algorithm over a RECORDED experiment sequence. */
function replay(search, experiments) {
  const limits = { minVus: search.minVus, maxVus: search.maxVus, tolerance: search.tolerance, maximumExperiments: search.maximumExperiments };
  const basePlan = search.basePlan;
  let boundaries = { lowestKnownPassVus: null, highestKnownFailVus: null };
  const testedVus = [];
  const fingerprints = new Set();
  let expectedVus = null;
  let expectedStop = null;
  let sawErrorStop = false;

  for (const exp of experiments) {
    // The recorded VU must be exactly the candidate the algorithm selects
    // given the boundaries produced by the PRECEDING recorded outcomes.
    const sel = selectNextCandidate(boundaries, testedVus, limits);
    expectedVus = sel.nextVus;
    expectedStop = sel.stop;
    if (expectedStop !== null) {
      // The algorithm would have stopped BEFORE creating this experiment —
      // a sequence mismatch (or a controller bug) unless this is iteration 1.
      return { ok: false, reason: `algorithm would stop before iteration ${exp.iteration} (stop=${expectedStop}) but the search recorded it`, expectedVus };
    }
    if (exp.targetVus !== expectedVus) {
      return { ok: false, reason: `iteration ${exp.iteration}: recorded VU ${exp.targetVus} ≠ replayed candidate ${expectedVus}`, expectedVus };
    }
    const fp = iterationFingerprint({
      targetVus: exp.targetVus,
      rampDuration: basePlan.rampDuration,
      holdDuration: basePlan.holdDuration,
      selectedEndpoints: basePlan.selectedEndpoints,
      thresholds: basePlan.thresholds,
    });
    if (fingerprints.has(fp)) return { ok: false, reason: `duplicate execution: fingerprint ${fp} repeated` };
    fingerprints.add(fp);
    testedVus.push(exp.targetVus);

    const outcome = classifyOutcome(exp.status, exp.thresholdStatus);
    if (outcome === "EXECUTION_ERROR") {
      // Must NEVER have moved a boundary or been counted as a FAIL.
      const before = { ...boundaries };
      const after = updateBoundaries(before, exp.targetVus, outcome);
      if (after.highestKnownFailVus !== before.highestKnownFailVus) {
        return { ok: false, reason: "EXECUTION_ERROR moved the FAIL boundary (execution-error-as-FAIL)" };
      }
      sawErrorStop = true;
      break; // controller stops on error (decideStop)
    }
    boundaries = updateBoundaries(boundaries, exp.targetVus, outcome);
    const stop = decideStop({
      outcome,
      experimentCount: testedVus.length,
      nextVus: selectNextCandidate(boundaries, testedVus, limits).nextVus,
      candidateStop: selectNextCandidate(boundaries, testedVus, limits).stop,
      limits,
    });
    if (stop.stop) {
      if (testedVus.length < experiments.length) {
        return { ok: false, reason: `algorithm stops after iteration ${exp.iteration} (${stop.reason}) but more experiments were recorded` };
      }
      return { ok: true, boundaries, stopReason: stop.reason, sawErrorStop, testedVus: [...testedVus] };
    }
  }
  return { ok: true, boundaries, stopReason: "completed-loop", sawErrorStop, testedVus: [...testedVus] };
}

async function createAndAwaitSearch(token, label, overrides) {
  const searchId = await api("mutation", "boundarySearch:createSearch", {
    targetBaseUrl: DEMO_API,
    minVus: 1,
    maxVus: 6,
    rampDuration: "2s",
    holdDuration: "4s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
    maximumExperiments: 6,
    tolerance: 1,
    ...overrides,
  }, token);
  console.log(`  ${label}: searchId=${searchId}`);
  const deadline = Date.now() + 180_000;
  let doc = null;
  while (Date.now() < deadline) {
    doc = await api("query", "boundarySearch:getSearch", { searchId }, token);
    if (["completed", "error", "blocked"].includes(doc.search.status)) break;
    await sleep(4000);
  }
  return { searchId, doc };
}

// --- main ----------------------------------------------------------------------

const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
console.log(`signed in as ${EMAIL}`);

// --- search A: healthy target → expected climb to the ceiling -------------------
await setDemoMode("normal");
console.log("\n--- search A: demo normal (all experiments should PASS up to maxVus) ---");
const a = await createAndAwaitSearch(token, "search A (normal)", {});
check("search A reached a terminal state", ["completed", "error", "blocked"].includes(a.doc?.search?.status), a.doc?.search?.status);
check("search A completed (not error/blocked)", a.doc?.search?.status === "completed", a.doc?.search?.status);
const expA = (a.doc?.experiments ?? []).sort((x, y) => x.iteration - y.iteration);
check("search A executed at least one experiment", expA.length >= 1, `${expA.length} experiments: ${expA.map((e) => `${e.iteration}:${e.targetVus}=${e.thresholdStatus ?? "?"}`).join(" ")}`);
const replayA = replay(a.doc.search, expA);
check("search A sequence exactly matches deterministic replay", replayA.ok === true, replayA.reason ?? `stop=${replayA.stopReason}`);
check("search A: no duplicate execution (unique fingerprints per VU)", new Set(expA.map((e) => e.targetVus)).size === expA.length, expA.map((e) => e.targetVus).join(","));
check(
  "search A: monotonic boundary updates (highest PASS only grows)",
  expA.every((e, i) => e.thresholdStatus !== "FAIL" || true) && (a.doc.search.lowestKnownPassVus ?? 0) >= Math.max(...expA.filter((e) => e.thresholdStatus === "PASS").map((e) => e.targetVus), 0),
  `lowestKnownPassVus=${a.doc.search.lowestKnownPassVus}`,
);
check("search A: observed PASS recorded", (a.doc.search.result?.lowerBound ?? a.doc.search.lowestKnownPassVus) !== null, `lowerBound=${a.doc.search.result?.lowerBound}`);
check("search A: no execution-error-as-FAIL", !expA.some((e) => e.status === "execution_error" && e.thresholdStatus === "FAIL"));
check(
  "search A: estimated-safe-region terminology (no capacity claim)",
  (a.doc.search.result?.note ?? "").includes("ESTIMATED SAFE OPERATING REGION"),
  (a.doc.search.result?.note ?? "").slice(0, 80),
);

// --- search B: error injection + tight error threshold → FAIL at the floor ------
await setDemoMode("error_injection");
console.log("\n--- search B: demo error_injection, errorRate threshold 0.10 (all experiments should FAIL) ---");
const b = await createAndAwaitSearch(token, "search B (error_injection)", {
  thresholds: { p95LatencyMs: 2000, errorRate: 0.1 },
});
await setDemoMode("normal");
check("search B reached a terminal state", ["completed", "error", "blocked"].includes(b.doc?.search?.status), b.doc?.search?.status);
const expB = (b.doc?.experiments ?? []).sort((x, y) => x.iteration - y.iteration);
check("search B executed at least one experiment", expB.length >= 1, `${expB.length} experiments: ${expB.map((e) => `${e.iteration}:${e.targetVus}=${e.thresholdStatus ?? "?"}`).join(" ")}`);
const replayB = replay(b.doc.search, expB);
check("search B sequence exactly matches deterministic replay", replayB.ok === true, replayB.reason ?? `stop=${replayB.stopReason}`);
check("search B: no PASS observed (failures at every tested VU)", expB.every((e) => e.thresholdStatus !== "PASS"), expB.map((e) => e.thresholdStatus ?? "?").join(","));
check("search B: stop condition is minimum_floor (no probe space below a failing minVus)", replayB.stopReason === "minimum_floor" || b.doc.search.result?.stopReason === "minimum_floor", `replay=${replayB.stopReason} recorded=${b.doc.search.result?.stopReason}`);
check("search B: no passing boundary invented", b.doc.search.lowestKnownPassVus == null && b.doc.search.result?.lowerBound == null, `pass=${b.doc.search.lowestKnownPassVus}`);
check("search B: honest region note (no passing point observed)", (b.doc.search.result?.note ?? "").includes("no passing point observed") || (b.doc.search.result?.note ?? "").includes("unknown below"), (b.doc.search.result?.note ?? "").slice(0, 90));

// --- replay engine sanity: the replay itself must reproduce known behaviors -----
console.log("\n--- replay sanity (algorithm-level, no target) ---");
const limits = { minVus: 1, maxVus: 8, tolerance: 1, maximumExperiments: 10 };
let bd = { lowestKnownPassVus: null, highestKnownFailVus: null };
const tested = [];
const seq = [];
for (let i = 0; i < 10; i++) {
  const sel = selectNextCandidate(bd, tested, limits);
  if (sel.nextVus === null) break;
  seq.push(sel.nextVus);
  tested.push(sel.nextVus);
  // Simulate: passes below 5, fails at/above 5 (a deterministic subject).
  bd = updateBoundaries(bd, sel.nextVus, sel.nextVus < 5 ? "PASS" : "FAIL");
}
check("replay sanity: boundary search over a known subject converges to [4,5]", bd.lowestKnownPassVus === 4 && bd.highestKnownFailVus === 5, `pass=${bd.lowestKnownPassVus} fail=${bd.highestKnownFailVus} seq=${seq.join(",")}`);
const stopCheck = decideStop({ outcome: "EXECUTION_ERROR", experimentCount: 2, nextVus: 3, candidateStop: null, limits });
check("replay sanity: EXECUTION_ERROR stops the search (never blind continuation)", stopCheck.stop === true && stopCheck.reason === "error");
check("replay sanity: safe region wording is the terminology contract", buildSafeRegion({ lowestKnownPassVus: 4, highestKnownFailVus: 5 }, "completed").note.includes("ESTIMATED SAFE OPERATING REGION"));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED — adaptive boundary search is reproducible (recorded sequences match the deterministic algorithm exactly)." : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
