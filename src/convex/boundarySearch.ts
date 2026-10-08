/**
 * Public functions for the deterministic adaptive boundary search UI
 * (default runtime). Creation is auth-gated and validates the requested
 * range INSIDE the existing safety limits — the controller can never raise
 * them, and neither can this entry point.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

/** Backed limits mirrored from backend/app/core/config.py defaults. */
const MAX_VUS_LIMIT = 2000;
const MAX_DURATION_S_LIMIT = 90;

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;
const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

function parseDurationSeconds(value: string): number {
  const m = DURATION_RE.exec(value);
  if (!m) throw new Error(`malformed duration: ${value}`);
  return parseInt(m[1]!, 10) * UNIT_SECONDS[m[2]!]!;
}

export const createSearch = mutation({
  args: {
    targetBaseUrl: v.string(),
    minVus: v.number(),
    maxVus: v.number(),
    rampDuration: v.string(),
    holdDuration: v.string(),
    selectedEndpoints: v.array(v.string()),
    endpointWeights: v.optional(v.record(v.string(), v.number())),
    thresholds: v.object({ p95LatencyMs: v.number(), errorRate: v.number() }),
    maximumExperiments: v.number(),
    tolerance: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required to start a boundary search");

    // --- validation: every future iteration must fit the existing limits ---
    if (!Number.isInteger(args.minVus) || !Number.isInteger(args.maxVus) || args.minVus < 1 || args.maxVus < args.minVus) {
      throw new Error("invalid search range: require integer 1 ≤ minVus ≤ maxVus");
    }
    if (args.maxVus > MAX_VUS_LIMIT) {
      throw new Error(`maxVus=${args.maxVus} exceeds the safety ceiling MAX_VUS=${MAX_VUS_LIMIT}`);
    }
    if (args.maximumExperiments < 1 || args.maximumExperiments > 20) {
      throw new Error("maximumExperiments must be between 1 and 20");
    }
    if (args.tolerance < 0) throw new Error("tolerance must be ≥ 0");
    if (!args.selectedEndpoints.length) throw new Error("at least one endpoint is required");
    const planned = parseDurationSeconds(args.rampDuration) + parseDurationSeconds(args.holdDuration);
    if (planned <= 0) throw new Error("ramp/hold durations must be positive");
    if (planned > MAX_DURATION_S_LIMIT) {
      throw new Error(`ramp+hold=${planned}s exceeds MAX_DURATION_S=${MAX_DURATION_S_LIMIT} (applies to every iteration)`);
    }
    if (args.thresholds.p95LatencyMs <= 0 || args.thresholds.errorRate < 0 || args.thresholds.errorRate > 1) {
      throw new Error("invalid thresholds");
    }

    const searchId = await ctx.db.insert("boundarySearches", {
      userId,
      targetBaseUrl: args.targetBaseUrl,
      status: "active",
      basePlan: {
        testType: "stress",
        rampDuration: args.rampDuration,
        holdDuration: args.holdDuration,
        selectedEndpoints: args.selectedEndpoints,
        ...(args.endpointWeights ? { endpointWeights: args.endpointWeights } : {}),
        thresholds: args.thresholds,
        assumptions: [
          "adaptive boundary search: deterministic controller, one LIVE_K6 experiment per iteration",
          "output is an estimated safe operating region, not an exact capacity",
        ],
      },
      minVus: args.minVus,
      maxVus: args.maxVus,
      tolerance: args.tolerance,
      maximumExperiments: args.maximumExperiments,
      currentIteration: 1,
      experimentCount: 0,
      experimentIds: [],
      createdAt: Date.now(),
    });

    // Kick the deterministic controller (no LLM anywhere in the loop).
    await ctx.scheduler.runAfter(0, internal.boundarySearchController.stepSearch, { searchId });
    return searchId;
  },
});

export const listSearches = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("boundarySearches")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

export const getSearch = query({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const search = await ctx.db.get(args.searchId);
    if (!search || search.userId !== userId) return null;
    const experiments = [];
    for (const runId of search.experimentIds ?? []) {
      const r = await ctx.db.get(runId);
      if (r) {
        experiments.push({
          runId,
          iteration: r.boundarySearchIteration ?? 0,
          targetVus: r.plan?.targetVus ?? 0,
          status: r.status,
          thresholdStatus: r.thresholdStatus ?? null,
          externalRunId: r.externalRunId ?? null,
          metrics: r.metrics ?? null,
        });
      }
    }
    return { search, experiments };
  },
});
