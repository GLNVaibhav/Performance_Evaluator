/**
 * Perforso engine evaluation driver.
 *
 * Drives the deployed Convex backend through the same API the web UI uses:
 *   interpretAndCompile -> createRun (schedules executeRun) -> poll getRun
 *
 * Usage: bun scripts/engine-eval.mjs
 * Env:   PERFSO_EMAIL / PERFSO_PASSWORD override the demo admin credentials.
 *
 * The engine is probe-first: reachable targets receive a bounded real-traffic
 * probe (measured GET requests) and results are real measurements; unreachable
 * targets fall back to the deterministic k6-style closed model and the run is
 * labelled `engineMode="simulation"`.
 */
const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";

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
console.log(`signed in as ${EMAIL}`);

const me = await api("query", "queries:currentUser", {}, token);
console.log("currentUser ->", me && me.email);

const missions = [
  { site: "https://animejs.com", intent: "Baseline https://animejs.com with 50 users for 30s, p95 under 400ms" },
  { site: "https://motion.dev", intent: "Stress https://motion.dev up to 200 users — find the breaking point" },
  { site: "https://kokonutui.pro", intent: "Baseline https://kokonutui.pro with 40 users for 30s, p95 under 500ms" },
  { site: "https://bklit.com", intent: "Soak https://bklit.com with 60 users for 45s" },
  { site: "https://ui.shadcn.com", intent: "Stress https://ui.shadcn.com up to 150 users, p95 under 600ms" },
];

const runs = [];
for (const m of missions) {
  const { interpretation, compilation } = await api("action", "mutations:interpretAndCompile", { input: m.intent }, token);
  console.log(`\n[${m.site}] interpreter=${interpretation.interpreter} status=${interpretation.status}`);
  if (!compilation || compilation.status !== "READY") {
    console.log(`  compile: ${compilation ? compilation.status : "null"} ${compilation?.rejectionReason ?? ""}`);
    runs.push({ site: m.site, runId: null });
    continue;
  }
  const runId = await api(
    "mutation",
    "mutations:createRun",
    { plan: compilation.plan, targetBaseUrl: m.site, rawInput: m.intent, interpreter: interpretation.interpreter },
    token,
  );
  console.log(
    `  run queued: ${runId} (vus=${compilation.plan.targetVus} dur=${compilation.plan.duration ?? "?"} eps=${compilation.plan.selectedEndpoints.length})`,
  );
  runs.push({ site: m.site, runId });
}

// Poll until all runs finish
const pending = new Map(runs.filter((r) => r.runId).map((r) => [r.runId, r]));
const deadline = Date.now() + 120_000;
const finished = [];
while (pending.size && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  for (const [runId, r] of [...pending]) {
    const run = await api("query", "queries:getRun", { runId }, token);
    if (["completed", "execution_error", "failed"].includes(run.status)) {
      finished.push({ ...r, run });
      pending.delete(runId);
      console.log(`  done: ${r.site} -> ${run.status}`);
    } else {
      console.log(`  .. ${r.site} ${run.status} ${run.progress ?? 0}%`);
    }
  }
}
for (const [, r] of pending) finished.push({ ...r, run: null });

console.log("\n================ EVALUATION REPORT ================");
for (const f of finished) {
  console.log(`\n## ${f.site}`);
  if (!f.run) { console.log("  (timed out)"); continue; }
  if (f.run.status !== "completed") { console.log(`  status=${f.run.status} err=${f.run.errorMessage ?? ""}`); continue; }
  const m = f.run.metrics;
  console.log(`  verdict=${f.run.thresholdStatus} score=${f.run.score} analyzer=${f.run.analyzer}`);
  console.log(
    `  requests=${m.totalRequests} errors=${m.totalFailures} (${(m.errorRate * 100).toFixed(2)}%)  p50=${m.p50}ms p95=${m.p95}ms p99=${m.p99}ms  maxRps=${m.maxRps} peakVUs=${m.peakVus}`,
  );
  console.log(`  summary: ${f.run.summary}`);
  for (const a of f.run.analysis) console.log(`   - ${a}`);
  if (f.run.thresholdViolations?.length) for (const v of f.run.thresholdViolations) console.log(`   x ${v}`);
}
