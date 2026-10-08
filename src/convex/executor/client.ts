/**
 * Bridge client: the ONLY place Convex talks to the FastAPI execution plane
 * over HTTPS. Submit → poll → fetch result. Never executes anything itself
 * and never falls back to simulation on failure (Phase 5).
 *
 * Transport is injected so tests can stub it; the Convex action wires the
 * real fetch.
 */

import type { FastApiRunCreateRequest } from "./contract";

export interface SubmitOutcome {
  externalRunId: string;
  status: string;
}

export interface BridgeClient {
  submit(request: FastApiRunCreateRequest): Promise<SubmitOutcome>;
  getStatus(externalRunId: string): Promise<{ status: string; errorMessage?: string | null; finishedAt?: string | null }>;
  getResult(externalRunId: string): Promise<unknown>;
}

export class ExecutionBackendUnreachableError extends Error {
  constructor(detail: string) {
    super(`execution backend unreachable: ${detail}`);
    this.name = "ExecutionBackendUnreachableError";
  }
}

export class ExecutionBackendError extends Error {
  constructor(
    public readonly httpStatus: number,
    detail: string,
  ) {
    super(`execution backend returned HTTP ${httpStatus}: ${detail}`);
    this.name = "ExecutionBackendError";
  }
}

export function makeBridgeClient(deps: {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): BridgeClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      });
    } catch (err) {
      // Network/DNS/timeout — distinguishable from an HTTP error status.
      throw new ExecutionBackendUnreachableError(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { detail?: unknown };
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j).slice(0, 300);
      } catch {
        detail = res.statusText;
      }
      throw new ExecutionBackendError(res.status, detail);
    }
    return (await res.json()) as T;
  }

  return {
    async submit(request) {
      const out = await call<{ run_id: string; status: string }>("runs", request);
      if (!out?.run_id) throw new Error("execution backend accepted the run but returned no run_id");
      return { externalRunId: out.run_id, status: out.status };
    },
    async getStatus(externalRunId) {
      const out = await call<{ run_id: string; status: string; error_message?: string | null; finished_at?: string | null }>(`runs/${encodeURIComponent(externalRunId)}`);
      return { status: out.status, errorMessage: out.error_message ?? null, finishedAt: out.finished_at ?? null };
    },
    async getResult(externalRunId) {
      return call<unknown>(`runs/${encodeURIComponent(externalRunId)}/result`);
    },
  };
}
