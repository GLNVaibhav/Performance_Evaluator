/**
 * PERFORMANCE REGRESSION INTELLIGENCE — AI interpretation query (Phase 10).
 *
 * Latest validated AI interpretation for a regression analysis (versioned,
 * append-only; latest() returns the highest version). Read-only.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const latestAiForRegression = query({
  args: { regressionId: v.id("regressionAnalyses") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const rows = await ctx.db
      .query("aiAnalyses")
      .withIndex("regressionAnalysisId", (q) => q.eq("regressionAnalysisId", args.regressionId))
      .collect();
    let latest = null;
    for (const doc of rows) {
      if (doc.userId !== userId) continue;
      if (!latest || doc.version > latest.version) latest = doc;
    }
    return latest;
  },
});
