/**
 * Bridge run state transitions (internal mutations/query). Deliberately
 * separate from executor.ts (the node-runtime action file): Convex runs
 * mutations in the default runtime, actions with Node APIs in the node
 * runtime — one file cannot mix them.
 *
 * All failure semantics live here: execution_error is an honest terminal
 * state, simulation is never substituted, and LIVE_K6 provenance is stored
 * verbatim with the result.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { mapBackendStatus } from "./executor/contract";

export const getBridgeRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

export const setSubmissionLock = internalMutation({
  args: { runId: v.id("runs"), until: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { submissionLockUntil: args.until });
  },
});

export const releaseSubmissionLock = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { submissionLockUntil: undefined });
  },
});

export const markSubmitted = internalMutation({
  args: { runId: v.id("runs"), externalRunId: v.string(), correlationId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "submitted",
      executionMode: "live_k6_pending",
      externalRunId: args.externalRunId,
      correlationId: args.correlationId,
    });
    // NOTE: the first poll is scheduled by the submit action (keeps this
    // module free of a scheduling cycle into the node-runtime executor).
  },
});

export const markSubmissionFailed = internalMutation({
  args: { runId: v.id("runs"), message: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "execution_error",
      executionMode: "live_k6",
      errorMessage: args.message,
      finishedAt: Date.now(),
    });
  },
});

export const applyPolledStatus = internalMutation({
  args: { runId: v.id("runs"), backendStatus: v.string(), errorMessage: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const status = mapBackendStatus(args.backendStatus);
    const patch: Record<string, unknown> = { status };
    if (args.errorMessage !== undefined && args.errorMessage !== null) patch.errorMessage = args.errorMessage;
    if (status === "execution_error") {
      patch.executionMode = "live_k6";
      patch.finishedAt = Date.now();
    }
    await ctx.db.patch(args.runId, patch);
    return status;
  },
});

export const saveLiveResult = internalMutation({
  args: {
    runId: v.id("runs"),
    metrics: v.object({
      totalRequests: v.number(),
      totalFailures: v.number(),
      errorRate: v.number(),
      p50: v.number(),
      p95: v.number(),
      p99: v.number(),
      maxRps: v.number(),
      peakVus: v.number(),
      iterations: v.number(),
      latencyAvgMs: v.number(),
      latencyMaxMs: v.number(),
    }),
    thresholdStatus: v.string(),
    thresholdViolations: v.array(v.string()),
    provenance: v.object({
      engine: v.string(),
      externalRunId: v.string(),
      source: v.string(),
      completedAt: v.string(),
      correlationId: v.string(),
      artifactPresent: v.boolean(),
      backendSummary: v.optional(v.string()),
    }),
    externalResult: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "completed",
      executionMode: "live_k6",
      engineMode: "live_k6",
      thresholdStatus: args.thresholdStatus,
      // Verdict label: a live k6 run IS a sustained-load run, so plain
      // PASS/FAIL semantics are honest here (unlike bounded-probe runs,
      // which carry PROBE_THRESHOLD_* labels).
      verdictLabel: args.thresholdStatus === "PASS" ? "PASS" : "FAIL",
      thresholdViolations: args.thresholdViolations,
      metrics: args.metrics,
      liveProvenance: args.provenance,
      externalResult: args.externalResult,
      // Deterministic backend metrics — no Convex analyzer involved. The
      // analyzer field records provenance of the narrative, and there is
      // none: the backend's own result is authoritative.
      analyzer: "k6",
      summary: `LIVE_K6: ${args.metrics.totalRequests} requests, p95 ${Math.round(args.metrics.p95)}ms, ${(args.metrics.errorRate * 100).toFixed(2)}% errors — thresholds ${args.thresholdStatus} (source: k6/results.json)`,
      progress: 100,
      finishedAt: Date.now(),
    });
  },
});
