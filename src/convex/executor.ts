/**
 * Executor bridge actions — the Convex control-plane side of the FastAPI
 * execution bridge (Phases 4, 5, 9). Node runtime ("use node") because the
 * correlation id needs crypto.randomUUID and the client needs fetch with
 * timeouts; all DB state transitions live in executorDb.ts (default runtime).
 *
 * Product flow enforced here:
 *   approved deterministic plan → submitExecutionRun (ONE submission lock)
 *   → externalRunId stored immediately → pollExecutionRun (paced, external
 *   id only) → fetch result → persist VERBATIM k6 metrics.
 *
 * Failure semantics (Phase 5/8): any bridge failure (unreachable backend,
 * HTTP error, malformed result, poll horizon) marks the run execution_error
 * with the real cause. Simulation is NEVER substituted for a failed live run.
 */
"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { randomUUID } from "node:crypto";
import {
  isPollHorizonExceeded,
  mapBackendResult,
  serializePlan,
  validateBackendResult,
} from "./executor/contract";
import type { ConvexTestPlan } from "./executor/contract";
import { makeBridgeClient, ExecutionBackendUnreachableError } from "./executor/client";
import type { BridgeClient } from "./executor/client";

const EXECUTION_BRIDGE_TOKEN_ENV = "EXECUTION_BRIDGE_TOKEN";
const SUBMISSION_LOCK_TTL_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

function bridgeConfig(): { baseUrl: string; token: string | undefined } {
  const baseUrl = (process.env.EXECUTION_BRIDGE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error("EXECUTION_BRIDGE_URL is not configured — no execution plane available");
  }
  return { baseUrl, token: process.env[EXECUTION_BRIDGE_TOKEN_ENV]?.trim() || undefined };
}

function makeClient(cfg: { baseUrl: string; token?: string }): BridgeClient {
  return makeBridgeClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    fetchImpl: fetch,
    timeoutMs: 20_000,
  });
}

/**
 * Submit an approved deterministic plan to the execution plane. Idempotent
 * under retry: if the run already has an externalRunId (or a live submission
 * lock), this returns WITHOUT creating a second live execution (Phase 9).
 */
export const submitExecutionRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args): Promise<{ externalRunId: string | null; alreadyLocked: boolean; error?: string }> => {
    const run = await ctx.runQuery(internal.executorDb.getBridgeRun, { runId: args.runId });
    if (!run || !run.plan) {
      throw new Error("run not found or has no plan");
    }

    // Duplicate-submission guard (Phase 9): never create a second live
    // execution for one logical run.
    if (run.externalRunId || (run.submissionLockUntil ?? 0) > Date.now()) {
      return { externalRunId: run.externalRunId ?? null, alreadyLocked: true };
    }

    // NOTE: no per-user auth check here — scheduled actions carry no user
    // context. Authorization happened in createRun (auth-gated mutation);
    // this action only ever executes for a run that already passed it.
    let request;
    try {
      const correlationId = randomUUID();
      request = serializePlan(
        run.plan as unknown as ConvexTestPlan,
        run.targetBaseUrl ?? "",
        correlationId,
        // Scheduled actions carry no user identity; the run record itself is
        // the authorization artifact (created by the auth-gated createRun).
        `convex-run:${args.runId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.executorDb.markSubmissionFailed, { runId: args.runId, message });
      return { externalRunId: null, alreadyLocked: false, error: message };
    }

    // Lock BEFORE the network call: a retry after a lost response must not
    // double-execute; recovery belongs to the poller (externalRunId lookup).
    await ctx.runMutation(internal.executorDb.setSubmissionLock, {
      runId: args.runId,
      until: Date.now() + SUBMISSION_LOCK_TTL_MS,
    });

    try {
      const client = makeClient(bridgeConfig());
      const outcome = await client.submit(request);
      await ctx.runMutation(internal.executorDb.markSubmitted, {
        runId: args.runId,
        externalRunId: outcome.externalRunId,
        correlationId: request.correlation_id,
      });
      // First poll — the poller re-schedules itself while non-terminal.
      await ctx.scheduler.runAfter(3_000, internal.executor.pollExecutionRun, { runId: args.runId });
      return { externalRunId: outcome.externalRunId, alreadyLocked: false };
    } catch (err) {
      const message =
        err instanceof ExecutionBackendUnreachableError
          ? `${err.message} (LIVE_K6 unavailable — no simulation fallback)`
          : err instanceof Error
            ? err.message
            : String(err);
      await ctx.runMutation(internal.executorDb.markSubmissionFailed, { runId: args.runId, message });
      return { externalRunId: null, alreadyLocked: false, error: message };
    }
  },
});

/**
 * One poll step for a submitted bridge run. Re-schedules itself while the
 * backend run is non-terminal; uses ONLY externalRunId (Phase 9). The poll
 * horizon (run.pollDeadlineAt) bounds the loop honestly (Phase 8.H).
 */
export const pollExecutionRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ terminal: boolean; status: string | null; transientError?: string }> => {
    const run = await ctx.runQuery(internal.executorDb.getBridgeRun, { runId: args.runId });
    if (!run?.externalRunId || ["completed", "execution_error", "cancelled"].includes(run.status)) {
      return { terminal: true, status: run?.status ?? null };
    }

    // Phase 8.H — polling horizon (pure helper, unit-tested): a submitted
    // run whose backend never reaches a terminal state must not poll
    // forever. Expiry is an honest execution_error, never a fallback.
    if (isPollHorizonExceeded(run, Date.now())) {
      await ctx.runMutation(internal.executorDb.markSubmissionFailed, {
        runId: args.runId,
        message: `bridge poll horizon exceeded without a terminal backend state (externalRunId=${run.externalRunId}); the backend run may still be executing — check the execution plane directly`,
      });
      return { terminal: true, status: "execution_error" };
    }

    const client = makeClient(bridgeConfig());
    let backend: { status: string; errorMessage?: string | null; finishedAt?: string | null };
    try {
      backend = await client.getStatus(run.externalRunId);
    } catch (err) {
      // Unreachable backend mid-poll: do NOT fail the run (it may still be
      // executing); re-schedule until the horizon expires.
      await ctx.scheduler.runAfter(POLL_INTERVAL_MS, internal.executor.pollExecutionRun, { runId: args.runId });
      return { terminal: false, status: run.status, transientError: err instanceof Error ? err.message : String(err) };
    }

    const mapped = await ctx.runMutation(internal.executorDb.applyPolledStatus, {
      runId: args.runId,
      backendStatus: backend.status,
      errorMessage: backend.errorMessage ?? undefined,
    });

    if (mapped === "completed") {
      try {
        const raw = await client.getResult(run.externalRunId);
        validateBackendResult(raw as never);
        const mappedResult = mapBackendResult(raw as never, run.plan as unknown as ConvexTestPlan, run.correlationId ?? "");
        const result = raw as { metrics?: { duration_s?: number } };
        await ctx.runMutation(internal.executorDb.saveLiveResult, {
          runId: args.runId,
          metrics: mappedResult.metrics,
          thresholdStatus: mappedResult.thresholdStatus,
          thresholdViolations: mappedResult.thresholdViolations,
          provenance: {
            ...mappedResult.provenance,
            backendSummary: `duration_s=${result.metrics?.duration_s ?? "?"}`,
          },
          externalResult: raw,
        });
        await ctx.runMutation(internal.executorDb.releaseSubmissionLock, { runId: args.runId });
        return { terminal: true, status: "completed" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.runMutation(internal.executorDb.markSubmissionFailed, {
          runId: args.runId,
          message: `result retrieval failed: ${message}`,
        });
        return { terminal: true, status: "execution_error" };
      }
    }

    if (mapped === "execution_error" || mapped === "cancelled") {
      await ctx.runMutation(internal.executorDb.releaseSubmissionLock, { runId: args.runId });
      return { terminal: true, status: mapped };
    }

    // Non-terminal (queued/running): re-schedule.
    await ctx.scheduler.runAfter(POLL_INTERVAL_MS, internal.executor.pollExecutionRun, { runId: args.runId });
    return { terminal: false, status: mapped };
  },
});
