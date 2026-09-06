import { api } from "./client";
import type {
  AIAnalysisResponse,
  RunCreateResponse,
  RunStatusResponse,
  TargetConfig,
  TestPlan,
  TestResult,
} from "./types";

export const runsApi = {
  create: (plan: TestPlan, target: TargetConfig) =>
    api.post<RunCreateResponse>("/runs", { plan, target }),

  status: (runId: string) => api.get<RunStatusResponse>(`/runs/${runId}`),

  result: (runId: string) => api.get<TestResult>(`/runs/${runId}/result`),

  list: (limit = 20) => api.get<RunStatusResponse[]>(`/runs?limit=${limit}`),

  // Final session -- separate, explicit AI-analysis step
  // (POST /api/v1/runs/{id}/analyze, verified against the real route in
  // backend/app/api/routes_runs.py). Never called automatically by
  // result(); the caller decides when (or whether) to request it.
  analyze: (runId: string) => api.post<AIAnalysisResponse>(`/runs/${runId}/analyze`),
};
