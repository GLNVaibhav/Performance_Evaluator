import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db.get(userId);
  },
});

export const listRuns = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("runs")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

export const getRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const run = await ctx.db.get(args.runId);
    return run && run.userId === userId ? run : null;
  },
});

export const listSamples = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== userId) return [];
    return await ctx.db
      .query("samples")
      .withIndex("runId", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

export const listLogs = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== userId) return [];
    return await ctx.db
      .query("logs")
      .withIndex("runId", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

export const bridgeConfigured = query({
  args: {},
  handler: async () => {
    // Non-secret configuration visibility for the UI: whether an execution
    // plane is configured (LIVE_K6 available). Never returns the URL/token.
    return !!process.env.EXECUTION_BRIDGE_URL;
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { total: 0, active: 0, passed: 0, failed: 0 };
    const runs = await ctx.db
      .query("runs")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    return {
      total: runs.length,
      active: runs.filter((r) => r.status === "running" || r.status === "queued").length,
      passed: runs.filter((r) => r.thresholdStatus === "PASS").length,
      failed: runs.filter((r) => r.thresholdStatus === "FAIL").length,
    };
  },
});
