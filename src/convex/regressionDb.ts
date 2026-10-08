/**
 * PERFORMANCE REGRESSION INTELLIGENCE — DB seam (Phase 10).
 *
 * Read the two immutable runs, compute the deterministic object, append a
 * regressionAnalyses document. Runs are NEVER mutated. Versioning is
 * monotonic per (baseline, candidate) pair; a re-analysis is a NEW row.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  computeDeterministicRegression,
  DEFAULT_REGRESSION_POLICY,
  REGRESSION_POLICY_VERSION,
  type DeterministicRegressionObject,
} from "./regression/core";

export const getRunInternal = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<Doc<"runs"> | null> => (await ctx.db.get(args.runId)) ?? null,
});

export const getRegressionInternal = internalQuery({
  args: { regressionId: v.id("regressionAnalyses") },
  handler: async (ctx, args): Promise<Doc<"regressionAnalyses"> | null> =>
    (await ctx.db.get(args.regressionId)) ?? null,
});

/** Internal insert used by the node-runtime analyst after AI interpretation. */
export const attachAiAnalysisInternal = internalMutation({
  args: {
    regressionId: v.id("regressionAnalyses"),
    aiAnalysisId: v.id("aiAnalyses"),
    aiAnalyzerKind: v.string(),
    aiGeneratedAt: v.number(),
    aiAnalysis: v.any(),
  },
  handler: async (ctx, args): Promise<null> => {
    // Narrow, additive patch of the regression row's AI linkage ONLY — the
    // deterministic object, run references, and versions are untouched.
    await ctx.db.patch(args.regressionId, {
      aiAnalysisId: args.aiAnalysisId,
      aiAnalyzerKind: args.aiAnalyzerKind,
      aiGeneratedAt: args.aiGeneratedAt,
      aiAnalysis: args.aiAnalysis,
    });
    return null;
  },
});

export const createRegressionInternal = internalMutation({
  args: {
    userId: v.id("users"),
    baselineRunId: v.id("runs"),
    candidateRunId: v.id("runs"),
    deterministic: v.any(),
  },
  handler: async (ctx, args): Promise<{ regressionId: Id<"regressionAnalyses">; version: number }> => {
    let version = 1;
    const prior = await ctx.db
      .query("regressionAnalyses")
      .withIndex("baselineRunId", (q) => q.eq("baselineRunId", args.baselineRunId))
      .collect();
    for (const doc of prior) {
      if (doc.candidateRunId === args.candidateRunId && doc.version >= version) version = doc.version + 1;
    }
    const id = await ctx.db.insert("regressionAnalyses", {
      userId: args.userId,
      baselineRunId: args.baselineRunId,
      candidateRunId: args.candidateRunId,
      version,
      policyVersion: REGRESSION_POLICY_VERSION,
      createdAt: Date.now(),
      deterministic: args.deterministic,
    });
    return { regressionId: id, version };
  },
});

// --- public entry: create a regression analysis (auth-gated) -------------------

export const createRegressionAnalysis = mutation({
  args: {
    baselineRunId: v.id("runs"),
    candidateRunId: v.id("runs"),
  },
  handler: async (ctx, args): Promise<{ regressionId: Id<"regressionAnalyses">; version: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required to create a regression analysis");

    const baseline = await ctx.db.get(args.baselineRunId);
    const candidate = await ctx.db.get(args.candidateRunId);
    if (!baseline || baseline.userId !== userId) throw new Error("Baseline run not found (or not yours)");
    if (!candidate || candidate.userId !== userId) throw new Error("Candidate run not found (or not yours)");

    // Deterministic engine — the ONLY computation performed here. Runs are
    // read, never written; INCOMPATIBLE/INCONCLUSIVE results are stored as-is
    // (never forced into a verdict).
    const deterministic = computeDeterministicRegression(baseline, candidate, DEFAULT_REGRESSION_POLICY);
    return await ctx.runMutation(internal.regressionDb.createRegressionInternal, {
      userId,
      baselineRunId: args.baselineRunId,
      candidateRunId: args.candidateRunId,
      deterministic,
    });
  },
});

// --- public queries -------------------------------------------------------------

export const listMyRegressionAnalyses = query({
  args: {},
  handler: async (ctx): Promise<(Doc<"regressionAnalyses"> & { deterministic: DeterministicRegressionObject })[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("regressionAnalyses")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

export const getMyRegressionAnalysis = query({
  args: { regressionId: v.id("regressionAnalyses") },
  handler: async (ctx, args): Promise<Doc<"regressionAnalyses"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const doc = await ctx.db.get(args.regressionId);
    return doc && doc.userId === userId ? doc : null;
  },
});
