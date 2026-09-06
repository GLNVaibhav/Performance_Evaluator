import { api } from "./client";
import type {
  IntentCompilationResponse,
  InterpretAndCompileResponse,
  InterpretationResult,
  KnownEndpointsResponse,
  UniversalPerformanceIntent,
} from "./types";

export const intentsApi = {
  interpret: (user_input: string) =>
    api.post<InterpretationResult>("/intents/interpret", { user_input }),

  compile: (intent: UniversalPerformanceIntent) =>
    api.post<IntentCompilationResponse>("/intents/compile", intent),

  interpretAndCompile: (user_input: string) =>
    api.post<InterpretAndCompileResponse>("/intents/interpret-and-compile", { user_input }),

  knownEndpoints: () => api.get<KnownEndpointsResponse>("/intents/known-endpoints"),
};
