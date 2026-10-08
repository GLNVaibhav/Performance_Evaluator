import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

export const markRunning = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { status: "running", startedAt: Date.now(), progress: 1 });
  },
});

export const markExecutionError = internalMutation({
  args: { runId: v.id("runs"), message: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "execution_error",
      finishedAt: Date.now(),
      errorMessage: args.message,
    });
  },
});

/** Record the execution mode actually used (set once, before streaming). */
export const setEngineMode = internalMutation({
  args: { runId: v.id("runs"), engineMode: v.string(), endpointsVerification: v.optional(v.array(v.object({ endpoint: v.string(), verified: v.boolean(), status: v.optional(v.number()), reason: v.optional(v.string()) }))) },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { engineMode: args.engineMode };
    if (args.endpointsVerification !== undefined) patch.endpointsVerification = args.endpointsVerification;
    await ctx.db.patch(args.runId, patch);
  },
});

export const appendLog = internalMutation({
  args: { runId: v.id("runs"), at: v.number(), phase: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("logs", { runId: args.runId, at: args.at, phase: args.phase, message: args.message });
  },
});

export const appendSample = internalMutation({
  args: {
    runId: v.id("runs"),
    tSec: v.number(),
    vus: v.number(),
    rps: v.number(),
    p50: v.number(),
    p95: v.number(),
    p99: v.number(),
    errors: v.number(),
    plannedVus: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { plannedVus, ...rest } = args;
    await ctx.db.insert("samples", plannedVus !== undefined ? { ...rest, plannedVus } : rest);
  },
});

export const updateProgress = internalMutation({
  args: { runId: v.id("runs"), progress: v.number(), currentVus: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { progress: args.progress };
    if (args.currentVus !== undefined) patch.currentVus = args.currentVus;
    await ctx.db.patch(args.runId, patch);
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("runs"),
    thresholdStatus: v.string(),
    verdictLabel: v.string(),
    violations: v.array(v.string()),
    engineMode: v.optional(v.string()), // "real" | "simulation"
    probeStats: v.optional(
      v.object({
        requests: v.number(),
        non2xx: v.number(),
        networkErrors: v.number(),
        probeUrls: v.array(v.string()),
      }),
    ),
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
      latencyAvgMs: v.optional(v.number()),
      latencyMaxMs: v.optional(v.number()),
    }),
    analysis: v.array(v.string()),
    summary: v.string(),
    analyzer: v.string(),
    score: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "completed",
      finishedAt: Date.now(),
      progress: 100,
      thresholdStatus: args.thresholdStatus,
      verdictLabel: args.verdictLabel,
      thresholdViolations: args.violations,
      engineMode: args.engineMode,
      probeStats: args.probeStats,
      metrics: args.metrics,
      analysis: args.analysis,
      summary: args.summary,
      analyzer: args.analyzer,
      score: args.score,
    });
  },
});
