/**
 * Convex functions mirroring the repo's REST contract:
 *   intents.interpretIntent  ~ POST /api/v1/intents/interpret (LLM, optional)
 *   intents.compileIntent    ~ POST /api/v1/intents/compile (deterministic)
 *   runs.createRun           ~ POST /api/v1/runs (approval gate + safety gates)
 * Execution follows the workflow contract: compile never runs anything;
 * only an approved READY plan reaches the engine.
 */
import { v } from "convex/values";
import { action, internalAction, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { interpret, compileIntent, validateWorkloadLimits } from "./functions";
import type { UniversalPerformanceIntent } from "./compiler";
import { simulateRun, evaluateThresholds, planStages } from "./engine";
import type { EngineTotals } from "./engine";
import { analyze } from "./analyzer";
import { probeTarget, assertSafeProbeUrl } from "./probe";
import type { ProbeResult } from "./probe";
import { buildRealEngine, verdictLabel } from "./realEngine";
import type { PlanShape, SampleRow } from "./realEngine";
import { compileIntentWithTargetContract, verifyTargetEndpoints, classifyTarget } from "./targetContract";
import type { EndpointVerification } from "./targetContract";

// --- Target safety gate (port of target_url_safety.py) ----------------------

const ALWAYS_BLOCKED_HOSTS = new Set(["169.254.169.254", "100.100.100.200"]);
const PRIVATE_RE = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]$)/i;

export function validateTargetUrlSafety(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid target URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("target.base_url must use http or https");
  }
  if (raw.match(/^https?:\/\/[^/]*@/i)) {
    throw new Error("target.base_url must not embed credentials (user:pass@host)");
  }
  const host = url.hostname.toLowerCase();
  if (ALWAYS_BLOCKED_HOSTS.has(host)) {
    throw new Error(`target host ${host} is blocked (cloud metadata endpoint)`);
  }
  // Default policy mirrors TARGET_SSRF_POLICY=allow_private (local demo targets allowed).
  void PRIVATE_RE;
  // WHATWG URL serialization appends "/" whenever the pathname is empty
  // (new URL("http://host:8080").toString() === "http://host:8080/"). The k6
  // script renderer joins BASE_URL + endpoint, so a serialized base URL made
  // every request "//products" → HTTP 404 on the whole run (observed live as
  // 50/50 failures during Phase 1 product-path validation, 2026-09-27;
  // the local e2e missed it because it passes the raw URL to serializePlan
  // directly, bypassing this gate). Strip exactly that serializer artifact —
  // meaningful stored paths ("https://api.example.com/v1") are untouched.
  return url.toString().replace(/\/$/, "");
}

// --- Intents ----------------------------------------------------------------

export const interpretIntent = action({
  args: { input: v.string() },
  handler: async (_ctx, args) => {
    return await interpret(args.input);
  },
});

export const compileIntentAction = action({
  args: { intent: v.any() },
  handler: async (_ctx, args) => {
    return compileIntent(args.intent as UniversalPerformanceIntent);
  },
});

// Mutation wrappers so reactive client components can call them directly.
export const compileIntentMutation = mutation({
  args: { intent: v.any() },
  handler: async (_ctx, args) => compileIntent(args.intent as UniversalPerformanceIntent),
});

export const interpretAndCompile = action({
  args: { input: v.string() },
  handler: async (_ctx, args) => {
    const interpretation = await interpret(args.input);
    if (
      (interpretation.status !== "COMPLETE" && interpretation.status !== "INCOMPLETE") ||
      !interpretation.intent
    ) {
      return { interpretation, compilation: null };
    }
    // Target-contract layer: if the request names a URL, compile THROUGH
    // endpoint validation — the LLM's endpoint suggestions are verified
    // against the target before any plan is called READY (BUG 1). Requests
    // without a URL keep the plain deterministic compile; the target is
    // chosen (and re-verified) at the approval/execution gates.
    const urlMatch = /https?:\/\/[^\s)\]}"]+/.exec(args.input);
    const target = urlMatch ? validateTargetUrlSafety(urlMatch[0]) : null;
    let intent = interpretation.intent;
    if (target) {
      // An explicitly-named path in the input URL is a first-class endpoint
      // candidate: never silently downgrade it to the site root. Merge it
      // into the intent so deterministic verification decides its fate —
      // an LLM that drops the path must not erase the user's request.
      let explicitPath: string | null = null;
      try {
        explicitPath = new URL(target).pathname;
      } catch {
        explicitPath = null; // validateTargetUrlSafety already guaranteed a valid URL
      }
      if (explicitPath && explicitPath !== "/") {
        const existing = intent.targetScope?.endpoints ?? [];
        if (!existing.includes(explicitPath)) {
          intent = {
            ...intent,
            targetScope: { ...intent.targetScope, endpoints: [explicitPath, ...existing] },
          };
        }
      }
    }
    const compilation = target
      ? await compileIntentWithTargetContract(intent, target)
      : compileIntent(intent);
    return { interpretation: { ...interpretation, intent }, compilation };
  },
});

// --- Runs -------------------------------------------------------------------

export const createRun = mutation({
  args: {
    plan: v.object({
      objectiveType: v.string(),
      testType: v.string(),
      targetVus: v.number(),
      duration: v.optional(v.string()),
      rampDuration: v.optional(v.string()),
      holdDuration: v.optional(v.string()),
      selectedEndpoints: v.array(v.string()),
      // Deterministic per-endpoint dispatch weights (Phase 3 experimentation):
      // optional; passed through verbatim to the FastAPI contract's
      // endpoint_weights (serializePlan validates positivity/exact-cover).
      endpointWeights: v.optional(v.record(v.string(), v.number())),
      thresholds: v.object({ p95LatencyMs: v.number(), errorRate: v.number() }),
      assumptions: v.array(v.string()),
    }),
    targetBaseUrl: v.string(),
    rawInput: v.optional(v.string()),
    interpreter: v.optional(v.string()),
    // Phase 5 execution modes: when true, the approved plan is submitted to
    // the FastAPI execution plane (LIVE_K6) instead of the local
    // probe/simulation engines. Never auto-set: the UI's approval gate
    // states it explicitly, and the plan is NOT re-verified against a
    // different execution plane's contract.
    executeViaBridge: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required to launch a run");

    // Safety gates (order mirrors run_service.create_run):
    const targetBaseUrl = validateTargetUrlSafety(args.targetBaseUrl);

    // args.plan arrives as an already-compiled CompiledPlan from the approval
    // gate — validate it directly. Re-running compileIntent here would parse a
    // plan-shaped object as an intent and spuriously reject it.
    const plan = args.plan as unknown as Parameters<typeof validateWorkloadLimits>[0];
    if (!plan || typeof plan.targetVus !== "number" || !Array.isArray(plan.selectedEndpoints) || !plan.selectedEndpoints.length) {
      throw new Error("invalid plan: missing targetVus or selectedEndpoints");
    }
    try {
      validateWorkloadLimits(plan);
    } catch (exc) {
      throw new Error(`plan rejected: ${exc instanceof Error ? exc.message : String(exc)}`);
    }

    const stages = planStages({
      plan: plan as never,
      targetBaseUrl,
    } as never);
    const plannedSeconds = stages.reduce((a, s) => a + s.durationSec, 0);

    const runId = await ctx.db.insert("runs", {
      userId,
      rawInput: args.rawInput,
      interpreter: args.interpreter,
      objective: args.plan.selectedEndpoints.join(", "),
      plan,
      status: "queued",
      targetBaseUrl,
      createdAt: Date.now(),
      progress: 0,
      plannedSeconds,
      ...(args.executeViaBridge
        ? {
            executionMode: "live_k6_pending" as const,
            pollDeadlineAt: Date.now() + 10 * 60_000,
          }
        : {}),
    });

    if (args.executeViaBridge) {
      // LIVE_K6 path: submit the deterministic plan to the execution plane.
      // The poller is scheduled by submitExecutionRun; submission itself is
      // an action (network) and must not run inside this mutation.
      await ctx.scheduler.runAfter(0, internal.executor.submitExecutionRun, { runId });
      return runId;
    }

    // Approval happened the moment the user submitted this approved plan —
    // schedule execution immediately (workflow contract step 4).
    await ctx.scheduler.runAfter(0, internal.mutations.executeRun, { runId });

    return runId;
  },
});

// --- Execution (background action, scheduled after approval) ----------------

export type { PlanShape, SampleRow } from "./realEngine";

interface EngineOutput {
  samples: SampleRow[];
  log: { at: number; phase: string; message: string }[];
  totals: EngineTotals;
  breakpoint: { stage: string; vus: number } | null;
  capacityVus: number;
  latencyAvgMs?: number;
  latencyMaxMs?: number;
  /** Real mode: measured peak in-flight requests. */
  measuredPeakConcurrent?: number;
}


export const executeRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.runsDb.getRun, { runId: args.runId });
    if (!run || !run.plan) {
      return;
    }
    const plan = run.plan as unknown as PlanShape;
    const targetBaseUrl = run.targetBaseUrl ?? "";

    try {
      await ctx.runMutation(internal.runsDb.markRunning, { runId: args.runId });

      const emitLog = (entry: { at: number; phase: string; message: string }) =>
        ctx.runMutation(internal.runsDb.appendLog, { runId: args.runId, ...entry });

      // ---- Phase 0: target-contract enforcement gate (BUG 1) --------------
      // Plans can arrive from any client, so endpoint availability is
      // re-established deterministically at execution time. Only the
      // verification GETs are spent — never a load run.
      //  - HTTP-proven non-existence (404/501/... on the path) or an unsafe
      //    URL → INVALID_TARGET: the run is refused, nothing is executed and
      //    no analyzer semantics are produced.
      //  - Network-level verification failure (target appears down) → NOT a
      //    refusal; the probe phase below confirms reachability and the run
      //    falls back to the labelled simulation path as before.
      const contractEndpoints: EndpointVerification[] = [];
      let gateMessage: string | null = null;
      if (targetBaseUrl && classifyTarget(targetBaseUrl) === "arbitrary_url") {
        try {
          assertSafeProbeUrl(targetBaseUrl);
          const contract = await verifyTargetEndpoints(targetBaseUrl, plan.selectedEndpoints);
          contractEndpoints.push(...contract.verifications);
          const failed = contract.verifications.filter((v) => !v.verified);
          if (failed.some((f) => f.status !== null)) {
            gateMessage =
              `INVALID_TARGET: the requested endpoint(s) could not be established as valid application/API operations on ${targetBaseUrl} — ` +
              failed
                .map((f) => (f.status !== null ? `${f.endpoint} (HTTP ${f.status})` : `${f.endpoint} (${f.reason})`))
                .join(", ") +
              `. No load was applied beyond the bounded verification GETs. Verify the path against the target's API contract (e.g. OpenAPI) or test the site root "/".`;
          }
        } catch (err) {
          gateMessage = `INVALID_TARGET: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (gateMessage) {
        await emitLog({ at: 0, phase: "verdict", message: gateMessage });
        await ctx.runMutation(internal.runsDb.setEngineMode, {
          runId: args.runId,
          engineMode: "real",
          endpointsVerification: contractEndpoints.map((v) => ({
            endpoint: v.endpoint,
            verified: v.verified,
            ...(v.status !== null ? { status: v.status } : {}),
            ...(v.reason !== null ? { reason: v.reason } : {}),
          })),
        });
        await ctx.runMutation(internal.runsDb.markExecutionError, {
          runId: args.runId,
          message: gateMessage,
        });
        return;
      }

      // ---- Phase 1: attempt a real, bounded traffic probe ----------------
      let probe: ProbeResult | null = null;
      let probeError: string | null = null;
      try {
        assertSafeProbeUrl(targetBaseUrl);
        probe = await probeTarget(targetBaseUrl, plan.selectedEndpoints);
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }

      const real = !!probe?.reachable;
      const engine: EngineOutput & { mode: "real" | "simulation" } = real
        ? { ...buildRealEngine(probe!, planStages(plan as never), plan, targetBaseUrl), mode: "real" }
        : (() => {
            const sim = simulateRun({ plan: plan as never, targetBaseUrl });
            return {
              ...sim,
              mode: "simulation" as const,
              log: [
                {
                  at: 0,
                  phase: "engine",
                  message: `mode=simulation — target did not answer HTTP probes (${probeError ?? probe?.errorSample ?? "unreachable"}); using the deterministic k6-style closed model`,
                },
                ...sim.log,
              ],
            };
          })();

      // Record the execution mode + contract outcome up front so the UI can
      // separate requested vs actual load from the first streamed sample.
      await ctx.runMutation(internal.runsDb.setEngineMode, {
        runId: args.runId,
        engineMode: engine.mode,
        endpointsVerification:
          contractEndpoints.length
            ? contractEndpoints.map((v) => ({
                endpoint: v.endpoint,
                verified: v.verified,
                ...(v.status !== null ? { status: v.status } : {}),
                ...(v.reason !== null ? { reason: v.reason } : {}),
              }))
            : (plan.selectedEndpoints ?? []).map((e) => ({ endpoint: e, verified: true })),
      });

      // ---- Phase 2: streamed ingest (logs first, then paced samples) -----
      for (const entry of engine.log) {
        await emitLog(entry);
      }

      const total = engine.samples.length;
      const CHUNK = real ? 4 : 30;
      const planned = real ? total : (run.plannedSeconds ?? total);
      const stepDelay = real ? 260 : Math.min(900, Math.max(140, (planned * 1000) / Math.max(1, total / CHUNK) / 12));
      for (let i = 0; i < total; i += CHUNK) {
        const chunk = engine.samples.slice(i, i + CHUNK);
        for (const s of chunk) {
          const { plannedVus, ...rest } = s as SampleRow & { plannedVus?: number };
          await ctx.runMutation(internal.runsDb.appendSample, {
            runId: args.runId,
            ...rest,
            ...(plannedVus !== undefined ? { plannedVus } : {}),
          });
        }
        const last = chunk[chunk.length - 1];
        await ctx.runMutation(internal.runsDb.updateProgress, {
          runId: args.runId,
          progress: Math.min(95, Math.round(((i + CHUNK) / total) * 100)),
          // Real mode: this is MEASURED in-flight request count (≤4), never
          // the requested VU envelope.
          currentVus: last.vus,
        });
        if (i + CHUNK < total) await new Promise((r) => setTimeout(r, stepDelay));
      }

      // ---- Phase 3: thresholds + analysis --------------------------------
      const thresholds = evaluateThresholds({
        thresholds: {
          p95LatencyMs: plan.thresholds.p95LatencyMs,
          errorRate: plan.thresholds.errorRate,
        },
        totals: engine.totals,
      });
      const analysis = await analyze({
        plan,
        targetBaseUrl,
        totals: engine.totals,
        thresholdStatus: thresholds.status,
        violations: thresholds.violations,
        breakpoint: engine.breakpoint,
        capacityVus: engine.capacityVus,
        mode: engine.mode,
        endpointsVerification: contractEndpoints.length ? contractEndpoints : null,
        unverifiedReason: null,
        probe: real && probe
          ? {
              requests: probe.totalRequests,
              statuses: probe.statuses,
              networkErrors: probe.networkErrors,
              probeUrls: probe.probeUrls,
              errorSample: probe.errorSample,
            }
          : null,
      });

      await ctx.runMutation(internal.runsDb.finishRun, {
        runId: args.runId,
        thresholdStatus: thresholds.status,
        verdictLabel: verdictLabel(engine.mode, thresholds.status),
        violations: thresholds.violations,
        engineMode: engine.mode,
        probeStats: real && probe
          ? {
              requests: probe.totalRequests,
              non2xx: probe.statuses.filter((s) => s >= 400).length,
              networkErrors: probe.networkErrors,
              probeUrls: probe.probeUrls,
            }
          : undefined,
        metrics: {
          totalRequests: engine.totals.totalRequests,
          totalFailures: engine.totals.totalFailures,
          errorRate: engine.totals.errorRate,
          p50: engine.totals.p50,
          p95: engine.totals.p95,
          p99: engine.totals.p99,
          maxRps: engine.totals.maxRps,
          peakVus: engine.totals.peakVus,
          iterations: engine.totals.iterations,
          ...(engine.mode === "real"
            ? { latencyAvgMs: engine.latencyAvgMs, latencyMaxMs: engine.latencyMaxMs }
            : {}),
        },
        analysis: analysis.points,
        summary: analysis.summary,
        analyzer: analysis.analyzer,
        score: analysis.score,
      });
    } catch (err) {
      await ctx.runMutation(internal.runsDb.markExecutionError, {
        runId: args.runId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

