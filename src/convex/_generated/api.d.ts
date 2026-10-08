/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_evidence from "../ai/evidence.js";
import type * as ai_validate from "../ai/validate.js";
import type * as aiAnalyst from "../aiAnalyst.js";
import type * as aiEntries from "../aiEntries.js";
import type * as aiQueries from "../aiQueries.js";
import type * as aiRuntimeDb from "../aiRuntimeDb.js";
import type * as analyzer from "../analyzer.js";
import type * as auth from "../auth.js";
import type * as boundarySearch from "../boundarySearch.js";
import type * as boundarySearchController from "../boundarySearchController.js";
import type * as boundarySearchDb from "../boundarySearchDb.js";
import type * as boundarySearchLogic from "../boundarySearchLogic.js";
import type * as compiler from "../compiler.js";
import type * as engine from "../engine.js";
import type * as evaluation_evidenceCorpus from "../evaluation/evidenceCorpus.js";
import type * as executor from "../executor.js";
import type * as executor_client from "../executor/client.js";
import type * as executor_contract from "../executor/contract.js";
import type * as executorDb from "../executorDb.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as interpreter from "../interpreter.js";
import type * as mutations from "../mutations.js";
import type * as percentile from "../percentile.js";
import type * as policies from "../policies.js";
import type * as probe from "../probe.js";
import type * as queries from "../queries.js";
import type * as realEngine from "../realEngine.js";
import type * as regression_aiEvidence from "../regression/aiEvidence.js";
import type * as regression_aiValidate from "../regression/aiValidate.js";
import type * as regression_core from "../regression/core.js";
import type * as regressionAnalyst from "../regressionAnalyst.js";
import type * as regressionDb from "../regressionDb.js";
import type * as regressionEntries from "../regressionEntries.js";
import type * as regressionQueries from "../regressionQueries.js";
import type * as runsDb from "../runsDb.js";
import type * as targetContract from "../targetContract.js";
import type * as versionManifest from "../versionManifest.js";
import type * as versionQueries from "../versionQueries.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "ai/evidence": typeof ai_evidence;
  "ai/validate": typeof ai_validate;
  aiAnalyst: typeof aiAnalyst;
  aiEntries: typeof aiEntries;
  aiQueries: typeof aiQueries;
  aiRuntimeDb: typeof aiRuntimeDb;
  analyzer: typeof analyzer;
  auth: typeof auth;
  boundarySearch: typeof boundarySearch;
  boundarySearchController: typeof boundarySearchController;
  boundarySearchDb: typeof boundarySearchDb;
  boundarySearchLogic: typeof boundarySearchLogic;
  compiler: typeof compiler;
  engine: typeof engine;
  "evaluation/evidenceCorpus": typeof evaluation_evidenceCorpus;
  executor: typeof executor;
  "executor/client": typeof executor_client;
  "executor/contract": typeof executor_contract;
  executorDb: typeof executorDb;
  functions: typeof functions;
  http: typeof http;
  interpreter: typeof interpreter;
  mutations: typeof mutations;
  percentile: typeof percentile;
  policies: typeof policies;
  probe: typeof probe;
  queries: typeof queries;
  realEngine: typeof realEngine;
  "regression/aiEvidence": typeof regression_aiEvidence;
  "regression/aiValidate": typeof regression_aiValidate;
  "regression/core": typeof regression_core;
  regressionAnalyst: typeof regressionAnalyst;
  regressionDb: typeof regressionDb;
  regressionEntries: typeof regressionEntries;
  regressionQueries: typeof regressionQueries;
  runsDb: typeof runsDb;
  targetContract: typeof targetContract;
  versionManifest: typeof versionManifest;
  versionQueries: typeof versionQueries;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
