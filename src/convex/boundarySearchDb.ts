/**
 * Adaptive boundary search — DB state transitions (internal queries and
 * mutations, default runtime). Deliberately separate from
 * boundarySearchController.ts (the node-runtime orchestrator), mirroring the
 * executor.ts / executorDb.ts split: one file cannot mix runtimes.
 *
 * All state transitions are transactional Convex mutations:
 *  - createIterationRun atomically claims the single active-iteration slot
 *    (§16) and inserts the iteration's run document, so the next experiment
 *    can only be created after the previous one reaches a terminal result.
 *  - applyIterationOutcome moves boundaries exactly per the deterministic
 *    rules (never on EXECUTION_ERROR) and clears the active slot.
 *  - finalizeSearch records the estimated safe operating region.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { classifyOutcome, updateBoundaries, buildSafeRegion } from "./boundarySearchLogic";
import type { IterationOutcome } from "./boundarySearchLogic";

type Ctx = { db: any };

// --- Queries -----------------------------------------------------------------

export const getSearch = internalQuery({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx: Ctx, args: { searchId: any }) => ctx.db.get(args.searchId),
});

export const getSearchForRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx: Ctx, args: { runId: any }) => {
    const run = await ctx.db.get(args.runId);
    if (!run?.boundarySearchId) return null;
    const search = await ctx.db.get(run.boundarySearchId);
    return { run, search };
  },
});

/** Iteration summaries for candidate selection + the UI. */
export const listSearchExperiments = internalQuery({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx: Ctx, args: { searchId: any }) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) return [];
    const rows: {
      runId: any;
      iteration: number;
      targetVus: number;
      status: string;
      thresholdStatus: string | null;
      externalRunId: string | null;
      fingerprint: string | null;
    }[] = [];
    for (const runId of search.experimentIds ?? []) {
      const r = await ctx.db.get(runId);
      if (r) {
        rows.push({
          runId,
          iteration: r.boundarySearchIteration ?? 0,
          targetVus: r.plan?.targetVus ?? 0,
          status: r.status,
          thresholdStatus: r.thresholdStatus ?? null,
          externalRunId: r.externalRunId ?? null,
          fingerprint: r.boundarySearchFingerprint ?? null,
        });
      }
    }
    return rows;
  },
});

/** §15 idempotency check, server-side authoritative. */
export const findExperimentByFingerprint = internalQuery({
  args: { searchId: v.id("boundarySearches"), fingerprint: v.string() },
  handler: async (ctx: Ctx, args: { searchId: any; fingerprint: string }) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) return null;
    for (const runId of search.experimentIds ?? []) {
      const r = await ctx.db.get(runId);
      if (r?.boundarySearchFingerprint === args.fingerprint) {
        return { runId, status: r.status, externalRunId: r.externalRunId ?? null, thresholdStatus: r.thresholdStatus ?? null };
      }
    }
    return null;
  },
});

// --- Mutations ---------------------------------------------------------------

/**
 * §16 single-active-iteration claim, transactional: clears any finished
 * previous iteration slot, then inserts the next iteration's run document
 * and points the search at it. Runs inside ONE mutation → no two iterations
 * can ever be active for one search.
 */
export const createIterationRun = internalMutation({
  args: {
    searchId: v.id("boundarySearches"),
    targetVus: v.number(),
    fingerprint: v.string(),
    plannedSeconds: v.number(),
  },
  handler: async (ctx: Ctx, args: { searchId: any; targetVus: number; fingerprint: string; plannedSeconds: number }) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) throw new Error("search not found");
    if (search.status !== "active") throw new Error(`search is ${search.status}, not active`);
    if (search.currentIterationRunId) {
      const current = await ctx.db.get(search.currentIterationRunId);
      if (current && !["completed", "execution_error", "cancelled"].includes(current.status)) {
        throw new Error("another iteration is still active for this search");
      }
    }

    const plan = {
      objectiveType: "boundary_search" as const,
      testType: search.basePlan.testType,
      targetVus: args.targetVus,
      rampDuration: search.basePlan.rampDuration,
      holdDuration: search.basePlan.holdDuration,
      selectedEndpoints: search.basePlan.selectedEndpoints,
      ...(search.basePlan.endpointWeights ? { endpointWeights: search.basePlan.endpointWeights } : {}),
      thresholds: search.basePlan.thresholds,
      assumptions: [
        ...search.basePlan.assumptions,
        `adaptive boundary search iteration ${search.currentIteration} (search ${args.searchId}): deterministic controller selected target_vus=${args.targetVus}`,
      ],
    };

    const runId = await ctx.db.insert("runs", {
      userId: search.userId,
      rawInput: `Adaptive boundary search iteration ${search.currentIteration} — target ${args.targetVus} VUs (deterministic controller)`,
      interpreter: "deterministic",
      objective: search.basePlan.selectedEndpoints.join(", "),
      plan,
      status: "queued",
      targetBaseUrl: search.targetBaseUrl,
      createdAt: Date.now(),
      progress: 0,
      plannedSeconds: args.plannedSeconds,
      executionMode: "live_k6_pending",
      pollDeadlineAt: Date.now() + 10 * 60_000,
      boundarySearchId: args.searchId,
      boundarySearchIteration: search.currentIteration,
      boundarySearchFingerprint: args.fingerprint,
    });

    await ctx.db.patch(args.searchId, {
      currentVus: args.targetVus,
      currentIterationRunId: runId,
      currentIteration: search.currentIteration + 1,
      experimentIds: [...(search.experimentIds ?? []), runId],
    });
    return { runId, iteration: search.currentIteration, plan };
  },
});

/**
 * Applies one terminal experiment outcome to the search state:
 * classifies (backend threshold result is authoritative), updates boundaries
 * per the deterministic rules (never on EXECUTION_ERROR), increments the
 * experiment count, and decides whether the search stops. Returns the
 * controller's next move; the controller schedules accordingly.
 */
export const applyIterationOutcome = internalMutation({
  args: {
    searchId: v.id("boundarySearches"),
    runId: v.id("runs"),
    status: v.string(),
    thresholdStatus: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (
    ctx: Ctx,
    args: { searchId: any; runId: any; status: string; thresholdStatus?: string; errorMessage?: string },
  ) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) throw new Error("search not found");

    // Idempotency: the outcome for a run is applied exactly once — while the
    // single-active slot still points at it. (createIterationRun clears the
    // slot when the outcome is applied; a later call for the same run is a
    // no-op.) This makes the controller's apply step safe to repeat across
    // crash recoveries and scheduled wake-ups.
    if (search.currentIterationRunId !== args.runId) {
      return { outcome: "ALREADY_APPLIED" as const, terminal: false, applied: false };
    }

    const outcome: IterationOutcome = classifyOutcome(args.status, args.thresholdStatus ?? null);
    const boundaries = updateBoundaries(
      {
        lowestKnownPassVus: search.lowestKnownPassVus ?? null,
        highestKnownFailVus: search.highestKnownFailVus ?? null,
      },
      search.currentVus ?? 0,
      outcome,
    );

    const experimentCount = search.experimentCount + 1;

    if (outcome === "EXECUTION_ERROR") {
      // §9.F / §4: do not continue blindly; record and terminalize honestly.
      const region = buildSafeRegion(boundaries, "blocked");
      await ctx.db.patch(args.searchId, {
        lowestKnownPassVus: boundaries.lowestKnownPassVus ?? undefined,
        highestKnownFailVus: boundaries.highestKnownFailVus ?? undefined,
        experimentCount,
        currentIterationRunId: undefined,
        status: "blocked",
        result: {
          status: region.status,
          lowerBound: region.estimatedSafeOperatingRegion.lowerBound ?? undefined,
          upperBound: region.estimatedSafeOperatingRegion.upperBound ?? undefined,
          lowestObservedFailingVus: region.lowestObservedFailingVus ?? undefined,
          highestObservedPassingVus: region.highestObservedPassingVus ?? undefined,
          note: region.note,
          stopReason: `execution_error: ${args.errorMessage ?? "unknown"}`,
        },
        finishedAt: Date.now(),
      });
      return { outcome, terminal: true };
    }

    // Record the observation and release the active-iteration slot.
    // Stopping is decided by the controller AFTER it selects the next
    // candidate (the controller owns tested-VU membership and the candidate
    // stop rules; this mutation only records the outcome deterministically).
    await ctx.db.patch(args.searchId, {
      lowestKnownPassVus: boundaries.lowestKnownPassVus ?? undefined,
      highestKnownFailVus: boundaries.highestKnownFailVus ?? undefined,
      experimentCount,
      currentIterationRunId: undefined,
    });
    return { outcome, terminal: false };
  },
});

/**
 * Terminalize a completed search with its estimated safe operating region
 * (§12). Deterministic; never fabricates a missing boundary.
 */
export const finalizeSearch = internalMutation({
  args: {
    searchId: v.id("boundarySearches"),
    finalStatus: v.string(), // completed | error | blocked
    stopReason: v.optional(v.string()),
  },
  handler: async (ctx: Ctx, args: { searchId: any; finalStatus: string; stopReason?: string }) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) throw new Error("search not found");
    const status = args.finalStatus === "completed" ? "completed" : args.finalStatus === "error" ? "error" : "blocked";
    const region = buildSafeRegion(
      {
        lowestKnownPassVus: search.lowestKnownPassVus ?? null,
        highestKnownFailVus: search.highestKnownFailVus ?? null,
      },
      status,
    );
    await ctx.db.patch(args.searchId, {
      status,
      result: {
        status: region.status,
        lowerBound: region.estimatedSafeOperatingRegion.lowerBound ?? undefined,
        upperBound: region.estimatedSafeOperatingRegion.upperBound ?? undefined,
        lowestObservedFailingVus: region.lowestObservedFailingVus ?? undefined,
        highestObservedPassingVus: region.highestObservedPassingVus ?? undefined,
        note: region.note,
        stopReason: args.stopReason,
      },
      currentIterationRunId: undefined,
      finishedAt: Date.now(),
    });
    return region;
  },
});

/**
 * §17 recovery probe: given an iteration run that already exists, report the
 * authoritative execution state so an interrupted controller can resume
 * polling instead of creating a duplicate k6 run.
 *
 * Race-window note (observed live during E2E validation): the executor marks
 * a run "completed" (applyPolledStatus) BEFORE saveLiveResult persists the
 * verbatim metrics/threshold verdict a moment later. A completed run without
 * a threshold verdict is therefore STILL SETTLING — the controller must wait
 * for the result rather than misclassify it as an execution error.
 */
export const getIterationState = internalQuery({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx: Ctx, args: { searchId: any }) => {
    const search = await ctx.db.get(args.searchId);
    if (!search) return null;
    if (!search.currentIterationRunId) return { active: false, run: null, search };
    const run = await ctx.db.get(search.currentIterationRunId);
    const status = run?.status ?? "";
    const terminal = ["completed", "execution_error", "cancelled"].includes(status);
    const resultReady = status !== "completed" || !!run?.thresholdStatus;
    return { active: !!run && !(terminal && resultReady), run, search };
  },
});
