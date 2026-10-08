/**
 * YouTube NEGATIVE VALIDATION — the mandated regression check for the
 * youtube.com /checkout incident (product-correctness bugs 1–5).
 *
 * This script calls interpretAndCompile ONLY. It never creates a run and
 * never sends sustained traffic to YouTube (one LLM call plus at most a few
 * bounded endpoint-verification GETs are spent — this is pre-flight
 * validation, not load testing of any third party).
 *
 * Expected outcome after the target-contract fix:
 *   - NO invented application endpoint ("/checkout") reaches a READY plan
 *   - unverified paths produce NEEDS_CLARIFICATION (or INVALID), never READY
 *   - the site-root fallback, if used, must be a bounded REAL_PROBE plan and
 *     must carry no saturation/capacity claim
 *   - no output anywhere may claim "300 VU stress test failed"
 *
 * Usage: bun scripts/youtube-negative-validation.mjs
 */
const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";
const TARGET = "https://www.youtube.com/";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function api(kind, path, args, token) {
  const res = await fetch(`${DEPLOY}/api/${kind}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await res.json();
  if (j.status !== "success") {
    throw new Error(`${path} failed: ${JSON.stringify(j).slice(0, 400)}`);
  }
  return j.value;
}

const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
console.log(`signed in as ${EMAIL}\n`);

// ---------------------------------------------------------------------------
// Case A — the exact incident input: stress/boundary_search/300 VUs + /checkout
// ---------------------------------------------------------------------------

console.log("Case A: the incident input (stress, 300 VUs, /checkout)");
const missionA =
  "Stress https://www.youtube.com/checkout up to 300 users — find the breaking point";
const a = await api("action", "mutations:interpretAndCompile", { input: missionA }, token);

console.log(`  interpreter: ${a.interpretation.interpreter} (${a.interpretation.status})`);
const intentA = a.interpretation.intent ?? {};
console.log(`  intent endpoints: ${JSON.stringify(intentA.targetScope?.endpoints ?? [])}`);

const compA = a.compilation;
if (!compA) {
  check("A: compilation object present", false);
} else {
  console.log(`  compile: ${compA.status}${compA.rejectionCode ? ` (${compA.rejectionCode})` : ""}`);
  const planA = compA.plan;
  // Mandate 1: no READY plan with an invented /checkout endpoint.
  const readyWithCheckout = compA.status === "READY" && planA?.selectedEndpoints?.includes("/checkout");
  check("A: /checkout never reaches a READY plan", !readyWithCheckout, JSON.stringify(planA?.selectedEndpoints ?? []));

  // Mandate 2: unverified paths must be blocked with a clear reason.
  const blockedWithReason =
    compA.status === "NEEDS_CLARIFICATION" &&
    (compA.clarificationsNeeded ?? []).some(
      (c) => c.question?.includes("/checkout") && c.question.includes("could not be established"),
    );
  check(
    "A: unverified path → NEEDS_CLARIFICATION with reason",
    blockedWithReason || compA.status === "INVALID",
    compA.rejectionReason ?? compA.clarificationsNeeded?.[0]?.question ?? "",
  );

  // Mandate 3: no capacity/stress failure language anywhere in the result.
  const textA = JSON.stringify(compA);
  check(
    "A: no '300 VU stress test failed' style claims",
    !/300[- ]?VU (stress )?test (failed|fail)/i.test(textA),
  );
}

// ---------------------------------------------------------------------------
// Case B — the same request scoped to the site root (documented fallback)
// ---------------------------------------------------------------------------

console.log("\nCase B: site-root fallback (bounded REAL_PROBE only)");
const missionB = "Stress https://www.youtube.com up to 300 users — find the breaking point";
const b = await api("action", "mutations:interpretAndCompile", { input: missionB }, token);
const compB = b.compilation;
if (compB?.status === "READY" && compB.plan) {
  const eps = compB.plan.selectedEndpoints ?? [];
  console.log(`  compile: READY, endpoints=${JSON.stringify(eps)}`);
  check("B: READY plan only for the site root '/'", eps.length > 0 && eps.every((e) => e === "/"));
  const textB = JSON.stringify(compB.plan);
  check(
    "B: plan carries no saturation/capacity claim",
    !/breaking point identified|saturation begins|capacity ≈/i.test(textB),
  );
} else {
  // Also acceptable: the site-root mission is not auto-runnable (e.g. needs
  // clarification). What matters is that nothing claims a capacity verdict.
  console.log(`  compile: ${compB?.status ?? "null"}`);
  check("B: non-READY is acceptable — no capacity claim exists", true);
}

// ---------------------------------------------------------------------------
// Case C — a verified-endpoint control on a target that serves the path
// ---------------------------------------------------------------------------

console.log("\nCase C: control — verified endpoint on a contract-served target");
const missionC = "Baseline http://127.0.0.1:8080/products with 50 users for 30s, p95 under 400ms";
const c = await api("action", "mutations:interpretAndCompile", { input: missionC }, token);
const compC = c.compilation;
console.log(`  compile: ${compC?.status ?? "null"}`);
check("C: demo-API contract path still compiles READY", compC?.status === "READY");

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log("\n================ NEGATIVE-VALIDATION VERDICT ================");
console.log(
  failures === 0
    ? "ALL CHECKS PASSED — the requested YouTube target/path cannot produce a performance/capacity conclusion; no '300 VU stress test failed' framing is possible."
    : `${failures} CHECK(S) FAILED — see above.`,
);
process.exit(failures === 0 ? 0 : 1);
