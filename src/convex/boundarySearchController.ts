/**
 * Deterministic adaptive boundary search — controller (node-runtime actions).
 *
 * ARCHITECTURE (per the phase brief §1): the controller is the deterministic
 * application layer between the user objective and the EXISTING LIVE_K6
 * product path. It advances one experiment at a time:
 *
 *   select next candidate (boundarySearchLogic.ts, pure)
 *     → createIterationRun (transactional single-active claim, §16)
 *     → internal.executor.submitExecutionRun  [UNCHANGED bridge submission]
 *     → executor's own poll chain persists the result verbatim
 *     → this action observes the terminal run, applies the outcome
 *       (boundary update rules, §6) and repeats until a stop condition (§9).
 *
 * NO LLM anywhere: next VU level, PASS/FAIL, stop conditions, and safety
 * limits are deterministic rules. The bridge, probe, and engine are untouched.
 *
 * CRASH/RECOVERY (§17): this action is re-entrant and idempotent. After an
 * interruption it re-derives everything from server-side state (the search
 * document + the iteration run's externalRunId/status) — it never creates a
 * duplicate k6 run because the active-iteration slot is claimed
 * transactionally and submission is idempotent (executor.submitExecutionRun's
 * own externalRunId/lock guard).
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  selectNextCandidate,
  decideStop,
  iterationFingerprint,
} from "./boundarySearchLogic";
import type { SearchBoundaries, SearchLimits } from "./boundarySearchLogic";

const RESCHEDULE_MS = 4_000;
const MAX_ITERATIONS_PER_INVOCATION = 50;

export const stepSearch = internalAction({
  args: { searchId: v.id("boundarySearches") },
  handler: async (ctx, args): Promise<{ done: boolean; note: string }> => {
    const search = await ctx.runQuery(internal.boundarySearchDb.getSearch, { searchId: args.searchId });
    if (!search) return { done: true, note: "search not found" };
    if (search.status !== "active") return { done: true, note: `search is ${search.status}` };

    const limits: SearchLimits = {
      minVus: search.minVus,
      maxVus: search.maxVus,
      tolerance: search.tolerance,
      maximumExperiments: search.maximumExperiments,
    };

    // --- §17 recovery + happy path: observe the active iteration, if any ---
    // Gated on the SLOT being occupied (state.run), not on "still executing":
    // once the result settles the slot still points at the terminal run, and
    // THIS is where its outcome gets applied exactly once (idempotent
    // slot-ownership guard in the DB mutation). Only an empty slot proceeds
    // to candidate selection.
    const state = await ctx.runQuery(internal.boundarySearchDb.getIterationState, { searchId: args.searchId });
    if (state?.run) {
      const run = state.run;
      const status = run.status as string;
      const terminal = ["completed", "execution_error", "cancelled"].includes(status);
      const settled = status !== "completed" || !!run.thresholdStatus;
      if (!terminal || !settled) {
        // Still executing (or the verbatim result has not settled yet — the
        // executor persists status before metrics). Re-schedule; never create
        // anything new while an iteration occupies the slot (§16).
        await ctx.scheduler.runAfter(RESCHEDULE_MS, internal.boundarySearchController.stepSearch, {
          searchId: args.searchId,
        });
        return { done: false, note: `iteration ${run.boundarySearchIteration ?? "?"} executing (${status})` };
      }
      // Terminal with a settled result → apply the outcome exactly once.
      const applied = await ctx.runMutation(internal.boundarySearchDb.applyIterationOutcome, {
        searchId: args.searchId,
        runId: run._id,
        status,
        thresholdStatus: run.thresholdStatus ?? undefined,
        errorMessage: run.errorMessage ?? undefined,
      });
      if (applied.applied === false) {
        // Outcome already applied (crash-after-apply window) → just proceed.
        return await continueOrFinalize(ctx, args.searchId, limits);
      }
      if (applied.outcome === "EXECUTION_ERROR") {
        return { done: true, note: `search blocked by execution error (iteration ${run.boundarySearchIteration ?? "?"})` };
      }
      return await continueOrFinalize(ctx, args.searchId, limits);
    }

    // --- max experiments guard (§9.B) ---------------------------------------
    if (search.experimentCount >= limits.maximumExperiments) {
      await ctx.runMutation(internal.boundarySearchDb.finalizeSearch, {
        searchId: args.searchId,
        finalStatus: "completed",
        stopReason: "maximum_experiments",
      });
      return { done: true, note: "stopped: maximum experiment count reached" };
    }

    // --- §7/§15: select the next candidate, skipping duplicates -------------
    const experiments = await ctx.runQuery(internal.boundarySearchDb.listSearchExperiments, { searchId: args.searchId });
    const testedVus = experiments.map((e: { targetVus: number }) => e.targetVus);
    const boundaries: SearchBoundaries = {
      lowestKnownPassVus: search.lowestKnownPassVus ?? null,
      highestKnownFailVus: search.highestKnownFailVus ?? null,
    };

    let nextVus: number | null = null;
    let candidateStop = null as ReturnType<typeof selectNextCandidate>["stop"];
    const workingTested = [...testedVus];
    for (let i = 0; i < MAX_ITERATIONS_PER_INVOCATION; i += 1) {
      const sel = selectNextCandidate(boundaries, workingTested, limits);
      if (sel.nextVus === null) {
        nextVus = null;
        candidateStop = sel.stop;
        break;
      }
      const fingerprint = fingerprintFor(search, sel.nextVus);
      const existing = await ctx.runQuery(internal.boundarySearchDb.findExperimentByFingerprint, {
        searchId: args.searchId,
        fingerprint,
      });
      if (existing) {
        if (!["completed", "execution_error", "cancelled"].includes(existing.status)) {
          // An identical experiment is somehow active → resume it instead of
          // creating a duplicate (§15/§17).
          await ctx.scheduler.runAfter(RESCHEDULE_MS, internal.boundarySearchController.stepSearch, {
            searchId: args.searchId,
          });
          return { done: false, note: `duplicate candidate already executing (run ${existing.runId})` };
        }
        // Already executed → treat as tested, pick the next candidate.
        workingTested.push(sel.nextVus);
        continue;
      }
      nextVus = sel.nextVus;
      candidateStop = null;
      break;
    }

    const stop = decideStop({
      outcome: "PASS", // irrelevant here: only count/ceiling paths can fire
      experimentCount: search.experimentCount,
      nextVus,
      candidateStop,
      limits,
    });
    if (stop.stop) {
      const reason = stop.reason === "error" ? "no_valid_candidate" : stop.reason ?? "no_valid_candidate";
      await ctx.runMutation(internal.boundarySearchDb.finalizeSearch, {
        searchId: args.searchId,
        finalStatus: "completed",
        stopReason: String(reason),
      });
      return { done: true, note: `stopped: ${reason}` };
    }

    const targetVus = nextVus as number;
    const fingerprint = fingerprintFor(search, targetVus);
    const rampSeconds = durationToSeconds(search.basePlan.rampDuration);
    const holdSeconds = durationToSeconds(search.basePlan.holdDuration);

    // --- create the iteration (transactional single-active claim, §16) ------
    let created: { runId: any; iteration: number };
    try {
      created = await ctx.runMutation(internal.boundarySearchDb.createIterationRun, {
        searchId: args.searchId,
        targetVus,
        fingerprint,
        plannedSeconds: rampSeconds + holdSeconds,
      });
    } catch (err) {
      // Another invocation claimed the slot (concurrent step) → re-schedule.
      await ctx.scheduler.runAfter(RESCHEDULE_MS, internal.boundarySearchController.stepSearch, {
        searchId: args.searchId,
      });
      return { done: false, note: `iteration creation deferred: ${err instanceof Error ? err.message : String(err)}` };
    }

    // --- execute through the EXISTING bridge path (unchanged) ---------------
    await ctx.scheduler.runAfter(0, internal.executor.submitExecutionRun, { runId: created.runId });
    await ctx.scheduler.runAfter(RESCHEDULE_MS, internal.boundarySearchController.stepSearch, {
      searchId: args.searchId,
    });
    return { done: false, note: `iteration ${created.iteration} created at ${targetVus} VUs — LIVE_K6 submission scheduled` };
  },
});

/**
 * After an outcome is applied: either more experiments remain (re-schedule)
 * or a deterministic stop condition finalizes the search with its estimated
 * safe operating region.
 */
async function continueOrFinalize(
  ctx: { scheduler: any; runQuery: any; runMutation: any },
  searchId: any,
  limits: SearchLimits,
): Promise<{ done: boolean; note: string }> {
  const search = await ctx.runQuery(internal.boundarySearchDb.getSearch, { searchId });
  if (!search || search.status !== "active") return { done: true, note: "search no longer active" };

  if (search.experimentCount >= limits.maximumExperiments) {
    await ctx.runMutation(internal.boundarySearchDb.finalizeSearch, {
      searchId,
      finalStatus: "completed",
      stopReason: "maximum_experiments",
    });
    return { done: true, note: "stopped: maximum experiment count reached" };
  }

  await ctx.scheduler.runAfter(1_000, internal.boundarySearchController.stepSearch, { searchId });
  return { done: false, note: `experiment ${search.experimentCount} recorded — selecting next candidate` };
}

function fingerprintFor(search: { basePlan: any }, targetVus: number): string {
  return iterationFingerprint({
    targetVus,
    rampDuration: search.basePlan.rampDuration,
    holdDuration: search.basePlan.holdDuration,
    selectedEndpoints: search.basePlan.selectedEndpoints,
    thresholds: search.basePlan.thresholds,
  });
}

/** Same k6-style duration grammar the backend's workload_limits.py parses. */
function durationToSeconds(value: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!m) return 0;
  const amount = parseInt(m[1]!, 10);
  const unit = m[2]!;
  return amount * (unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : 3600);
}
