/**
 * AI Performance Intelligence — queries (default runtime).
 *
 * Read-only access to stored analyses for the UI. Analyses are versioned
 * and immutable; latest() returns the highest version for a subject.
 * The authoritative deterministic result always lives on the run/search
 * documents themselves — these queries never touch it.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const latestForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const rows = await ctx.db
      .query("aiAnalyses")
      .withIndex("runId", (q) => q.eq("runId", args.runId))
      .collect();
    let latest = null;
    for (const doc of rows) {
      if (doc.userId !== userId) continue;
      if (!latest || doc.version > latest.version) latest = doc;
    }
    return latest;
  },
});

export const latestForSearch = query({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const rows = await ctx.db
      .query("aiAnalyses")
      .withIndex("boundarySearchId", (q) => q.eq("boundarySearchId", args.searchId))
      .collect();
    let latest = null;
    for (const doc of rows) {
      if (doc.userId !== userId) continue;
      if (!latest || doc.version > latest.version) latest = doc;
    }
    return latest;
  },
});
