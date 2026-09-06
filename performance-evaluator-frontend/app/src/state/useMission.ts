import { useCallback, useReducer, useRef } from "react";
import { intentsApi } from "../api/intents";
import { runsApi } from "../api/runs";
import { ApiError } from "../api/client";
import type {
  AuthConfig,
  IntentCompilationResponse,
  InterpretationResult,
  RunState,
  TestResult,
} from "../api/types";

export type MissionStage =
  | "idle"
  | "interpreting"
  | "interpreted"
  | "compiling"
  | "compiled"
  | "awaiting_approval"
  | "launching"
  | "running"
  | "completed"
  | "execution_error"
  | "blocked"; // NEEDS_CLARIFICATION, INVALID, AMBIGUOUS, INTERPRETATION_FAILURE

export interface MissionState {
  stage: MissionStage;
  input: string;
  interpretation?: InterpretationResult;
  compilation?: IntentCompilationResponse;
  targetBaseUrl: string;
  runId?: string;
  runState?: RunState;
  result?: TestResult;
  runErrorMessage?: string;
  networkError?: string;
}

type Action =
  | { type: "RESET" }
  | { type: "SET_INPUT"; input: string }
  | { type: "SET_TARGET"; url: string }
  | { type: "INTERPRET_START" }
  | { type: "INTERPRET_DONE"; result: InterpretationResult }
  | { type: "COMPILE_START" }
  | { type: "COMPILE_DONE"; result: IntentCompilationResponse }
  | { type: "LAUNCH_START" }
  | { type: "RUN_CREATED"; runId: string; state: RunState }
  | { type: "RUN_STATUS"; state: RunState }
  | { type: "RUN_COMPLETED"; result: TestResult }
  | { type: "RUN_EXECUTION_ERROR"; message: string }
  | { type: "NETWORK_ERROR"; message: string };

const initial: MissionState = { stage: "idle", input: "", targetBaseUrl: "http://127.0.0.1:8080" };

function reducer(state: MissionState, action: Action): MissionState {
  switch (action.type) {
    case "RESET":
      return { ...initial, targetBaseUrl: state.targetBaseUrl };
    case "SET_INPUT":
      return { ...state, input: action.input };
    case "SET_TARGET":
      return { ...state, targetBaseUrl: action.url };
    case "INTERPRET_START":
      return { ...state, stage: "interpreting", networkError: undefined };
    case "INTERPRET_DONE": {
      if (action.result.status !== "COMPLETE" && action.result.status !== "INCOMPLETE") {
        // AMBIGUOUS / INVALID / INTERPRETATION_FAILURE -- nothing safe to
        // compile. Stop here, do not proceed to compilation.
        return { ...state, stage: "blocked", interpretation: action.result };
      }
      return { ...state, stage: "interpreted", interpretation: action.result };
    }
    case "COMPILE_START":
      return { ...state, stage: "compiling" };
    case "COMPILE_DONE": {
      if (action.result.status === "READY") {
        return { ...state, stage: "awaiting_approval", compilation: action.result };
      }
      // NEEDS_CLARIFICATION or INVALID -- must never reach execution.
      return { ...state, stage: "blocked", compilation: action.result };
    }
    case "LAUNCH_START":
      return { ...state, stage: "launching" };
    case "RUN_CREATED":
      return { ...state, stage: "running", runId: action.runId, runState: action.state };
    case "RUN_STATUS":
      return { ...state, runState: action.state };
    case "RUN_COMPLETED":
      return { ...state, stage: "completed", result: action.result };
    case "RUN_EXECUTION_ERROR":
      return { ...state, stage: "execution_error", runErrorMessage: action.message };
    case "NETWORK_ERROR":
      return { ...state, networkError: action.message };
    default:
      return state;
  }
}

export function useMission() {
  const [state, dispatch] = useReducer(reducer, initial);
  const pollHandle = useRef<number | null>(null);

  const setInput = (input: string) => dispatch({ type: "SET_INPUT", input });
  const setTarget = (url: string) => dispatch({ type: "SET_TARGET", url });
  const reset = () => {
    if (pollHandle.current) window.clearInterval(pollHandle.current);
    dispatch({ type: "RESET" });
  };

  // Two real, sequential calls -- interpret, THEN compile -- rather than
  // the single /interpret-and-compile convenience endpoint, so each UI
  // stage genuinely corresponds to its own network round trip, not a
  // staged reveal of data that all arrived at once.
  const submitMission = useCallback(async (input: string) => {
    dispatch({ type: "SET_INPUT", input });
    dispatch({ type: "INTERPRET_START" });
    try {
      const interpretation = await intentsApi.interpret(input);
      dispatch({ type: "INTERPRET_DONE", result: interpretation });
      if (interpretation.status !== "COMPLETE" && interpretation.status !== "INCOMPLETE") return;
      if (!interpretation.intent) return;

      dispatch({ type: "COMPILE_START" });
      const compilation = await intentsApi.compile(interpretation.intent);
      dispatch({ type: "COMPILE_DONE", result: compilation });
    } catch (e) {
      const msg = e instanceof ApiError ? String(e.detail) : "network error contacting backend";
      dispatch({ type: "NETWORK_ERROR", message: msg });
    }
  }, []);

  const approveAndExecute = useCallback(
    async (targetBaseUrl: string, auth?: AuthConfig) => {
      if (!state.compilation?.test_plan) return;
      dispatch({ type: "SET_TARGET", url: targetBaseUrl });
      dispatch({ type: "LAUNCH_START" });
      try {
        // `auth` (Sessions 1/2/2.5) is forwarded to POST /runs verbatim,
        // never stored back into MissionState -- it must not linger in
        // memory/UI state any longer than the single request that needs
        // it (see backend/docs/target_auth_contract.md's secret-lifecycle
        // discussion for the same principle applied backend-side).
        const created = await runsApi.create(state.compilation.test_plan, { base_url: targetBaseUrl, auth });
        dispatch({ type: "RUN_CREATED", runId: created.run_id, state: created.status });

        pollHandle.current = window.setInterval(async () => {
          try {
            const status = await runsApi.status(created.run_id);
            dispatch({ type: "RUN_STATUS", state: status.status });
            if (status.status === "COMPLETED") {
              if (pollHandle.current) window.clearInterval(pollHandle.current);
              const result = await runsApi.result(created.run_id);
              dispatch({ type: "RUN_COMPLETED", result });
            } else if (status.status === "EXECUTION_ERROR" || status.status === "CANCELLED") {
              if (pollHandle.current) window.clearInterval(pollHandle.current);
              dispatch({
                type: "RUN_EXECUTION_ERROR",
                message: status.error_message ?? `run ended in state ${status.status}`,
              });
            }
          } catch {
            // transient poll failure -- keep polling, don't abort the run view
          }
        }, 1200);
      } catch (e) {
        const msg = e instanceof ApiError ? String(e.detail) : "network error contacting backend";
        dispatch({ type: "NETWORK_ERROR", message: msg });
      }
    },
    [state.compilation]
  );

  return { state, setInput, setTarget, reset, submitMission, approveAndExecute };
}
