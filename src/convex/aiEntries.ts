/**
 * AI Performance Intelligence — PUBLIC entry points (default runtime).
 *
 * Auth-gated actions so the UI can request an analysis for a run or a
 * boundary search the caller owns. Zero execution authority: the analyst
 * can only read evidence and append a versioned analysis document.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

export const analyzeMyRun = action({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required");
    const run = await ctx.runQuery(internal.aiRuntimeDb.getRun, { runId: args.runId });
    if (!run || run.userId !== userId) {
      throw new Error("Run not found (or not yours)");
    }
    return await ctx.runAction(internal.aiAnalyst.analyzeRun, { runId: args.runId });
  },
});

export const analyzeMySearch = action({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args): Promise<{ analysisId: Id<"aiAnalyses">; version: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required");
    const search = await ctx.runQuery(internal.aiRuntimeDb.getSearch, { searchId: args.searchId });
    if (!search || search.userId !== userId) {
      throw new Error("Search not found (or not yours)");
    }
    return await ctx.runAction(internal.aiAnalyst.analyzeSearch, { searchId: args.searchId });
  },
});
