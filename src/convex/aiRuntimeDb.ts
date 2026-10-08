/**
 * AI Performance Intelligence — internal runtime helpers.
 *
 * A tiny query/mutation seam so the node-runtime actions (aiAnalyst.ts)
 * can read raw documents and append versioned analyses. Never exposes
 * execution authority: it can only READ runs/searches and INSERT
 * aiAnalyses documents. Analyses are append-only (a regeneration is a
 * NEW document; nothing here ever patches runs/searches/analyses).
 *
 * Type note: every handler carries an EXPLICIT return annotation built
 * on Convex's generated Doc types. Without them, the cross-referencing
 * actions (aiAnalyst/aiEntries) collapsed into TS7022 inference cycles
 * under this Convex+TS version.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<Doc<"runs"> | null> => (await ctx.db.get(args.runId)) ?? null,
});

export const getSearch = internalQuery({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args): Promise<Doc<"boundarySearches"> | null> =>
    (await ctx.db.get(args.searchId)) ?? null,
});

export const getRegressionAnalysis = internalQuery({
  args: { regressionAnalysisId: v.id("regressionAnalyses") },
  handler: async (ctx, args): Promise<Doc<"regressionAnalyses"> | null> =>
    (await ctx.db.get(args.regressionAnalysisId)) ?? null,
});

/** Append-only: a new analysis is a NEW document. Nothing is patched. */
export const storeAnalysis = internalMutation({
  args: {
    userId: v.id("users"),
    subjectKind: v.union(v.literal("run"), v.literal("boundary_search"), v.literal("regression")),
    runId: v.optional(v.id("runs")),
    boundarySearchId: v.optional(v.id("boundarySearches")),
    regressionAnalysisId: v.optional(v.id("regressionAnalyses")),
    analyzerKind: v.union(v.literal("llm"), v.literal("deterministic")),
    model: v.optional(v.string()),
    promptVersion: v.string(),
    analysis: v.any(),
    evidenceRefs: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    let version = 1;
    if (args.subjectKind === "run" && args.runId) {
      const prior = await ctx.db
        .query("aiAnalyses")
        .withIndex("runId", (q) => q.eq("runId", args.runId))
        .collect();
      for (const doc of prior) if (doc.version >= version) version = doc.version + 1;
    } else if (args.subjectKind === "boundary_search" && args.boundarySearchId) {
      const prior = await ctx.db
        .query("aiAnalyses")
        .withIndex("boundarySearchId", (q) => q.eq("boundarySearchId", args.boundarySearchId))
        .collect();
      for (const doc of prior) if (doc.version >= version) version = doc.version + 1;
    } else if (args.subjectKind === "regression" && args.regressionAnalysisId) {
      const prior = await ctx.db
        .query("aiAnalyses")
        .withIndex("regressionAnalysisId", (q) => q.eq("regressionAnalysisId", args.regressionAnalysisId))
        .collect();
      for (const doc of prior) if (doc.version >= version) version = doc.version + 1;
    }
    const id = await ctx.db.insert("aiAnalyses", {
      userId: args.userId,
      subjectKind: args.subjectKind,
      runId: args.runId,
      boundarySearchId: args.boundarySearchId,
      regressionAnalysisId: args.regressionAnalysisId,
      version,
      analyzerKind: args.analyzerKind,
      model: args.model,
      promptVersion: args.promptVersion,
      generatedAt: Date.now(),
      analysis: args.analysis,
      evidenceRefs: args.evidenceRefs,
    });
    return { analysisId: id, version };
  },
});
