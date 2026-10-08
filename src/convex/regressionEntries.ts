/**
 * PERFORMANCE REGRESSION INTELLIGENCE — PUBLIC ENTRY POINTS (Phase 10).
 *
 * Auth-gated action: request an AI interpretation for a regression analysis
 * the caller owns. Zero execution authority — the analyst only reads the two
 * immutable runs and appends a versioned interpretation document.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

export const analyzeMyRegression = action({
  args: { regressionId: v.id("regressionAnalyses") },
  handler: async (ctx, args): Promise<{ analysisId: string; version: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required");
    const regression = await ctx.runQuery(internal.regressionDb.getRegressionInternal, {
      regressionId: args.regressionId,
    });
    if (!regression || regression.userId !== userId) {
      throw new Error("Regression analysis not found (or not yours)");
    }
    return await ctx.runAction(internal.regressionAnalyst.analyzeRegression, {
      regressionId: args.regressionId,
    });
  },
});
