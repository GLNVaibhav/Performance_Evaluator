/**
 * Reproducibility manifest — CONVEX CONTROL PLANE (Phase 11).
 *
 * One deterministic snapshot of the version identities needed to interpret
 * or reproduce a recorded result, mirror-imaged with the backend's
 * GET /api/v1/version (backend/app/version_manifest.py). Pure data — a
 * public query (versionQueries.ts) serves it; no secrets, no config
 * VALUES, only names, versions, and booleans.
 *
 * Where each field comes from:
 *  - GIT_COMMIT / GIT_COMMIT_TIME: baked into the bundle by Vite's
 *    `define` when the build ran inside a git checkout (see vite.config.ts);
 *    otherwise UNKNOWN — never inferred, per the Phase 11 rule.
 *  - runtime versions: process.versions in the node runtime (guarded —
 *    this module must stay importable from the default runtime too).
 *  - policy versions: src/convex/policies.ts + backend/app/policies.py's
 *    published identities (frozen here as constants for reporting).
 *  - bridge/model: configuration PRESENCE only, never values.
 */

import { CONTROL_PLANE_POLICY_VERSIONS } from "./policies";

export const VERSION_MANIFEST_SCHEMA = "perforso.version-manifest.v1";

// Vite bakes these at build time (vite.config.ts `define`). When the build
// did not run inside a git checkout (e.g. a clean CI checkout without
// .git), they stay UNKNOWN — an honest unknown beats a wrong guess.
declare const __GIT_COMMIT__: string | undefined;
declare const __GIT_COMMIT_TIME__: string | undefined;

const GIT_COMMIT: string = typeof __GIT_COMMIT__ === "string" && __GIT_COMMIT__ ? __GIT_COMMIT__ : "UNKNOWN";
const GIT_COMMIT_TIME: string =
  typeof __GIT_COMMIT_TIME__ === "string" && __GIT_COMMIT_TIME__ ? __GIT_COMMIT_TIME__ : "UNKNOWN";

export interface VersionManifest {
  schema_version: string;
  plane: "convex-control-plane";
  git_commit: string;
  git_commit_time: string;
  node_runtime_version: string;
  convex_sdk_version: string;
  react_version: string;
  backend_versions: {
    python: string;
    fastapi: string;
    k6: string;
    source: string;
  };
  demo_api_version: string;
  policies: {
    control_plane: Record<string, string>;
    backend: Record<string, string>;
  };
  configuration: {
    execution_bridge_url_configured: boolean;
    llm_configured: boolean;
    llm_model_default: string;
  };
  environment_variable_names: string[];
}

const BACKEND_POLICY_VERSIONS: Record<string, string> = {
  workloadLimits: "perforso.workload-limits.v1",
  threshold: "perforso.threshold.v1",
  boundarySearch: "perforso.boundary-search.v1",
  targetSsrf: "perforso.target-ssrf.v1",
};

function nodeMajor(): string {
  try {
    // Guarded: works in the node runtime; in the default runtime
    // process.versions.node is still defined under Convex, but stay safe.
    return (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

export function buildVersionManifest(): VersionManifest {
  const pkgVersions = resolvePackageVersions();
  return {
    schema_version: VERSION_MANIFEST_SCHEMA,
    plane: "convex-control-plane",
    git_commit: GIT_COMMIT,
    git_commit_time: GIT_COMMIT_TIME,
    node_runtime_version: nodeMajor(),
    convex_sdk_version: pkgVersions.convex,
    react_version: pkgVersions.react,
    // The backend reports its own live values at GET /api/v1/version; these
    // are the versions this repository pins/documents (source noted).
    backend_versions: {
      python: "3.10 (backend/.venv; Dockerfile.backend pins python:3.10-slim)",
      fastapi: "0.115.6 (backend/requirements.txt)",
      k6: "k6 binary — live value reported by GET /api/v1/version; Dockerfile.backend pins K6_VERSION",
      source: "backend/requirements.txt + Dockerfile.backend; authoritative live values from the execution plane",
    },
    demo_api_version: "perforso.demo-api.v1 (in-memory modes; see demo-api/README.md)",
    policies: {
      control_plane: { ...CONTROL_PLANE_POLICY_VERSIONS },
      backend: BACKEND_POLICY_VERSIONS,
    },
    configuration: {
      execution_bridge_url_configured: !!strip(process.env.EXECUTION_BRIDGE_URL),
      llm_configured: !!strip(process.env.LLM_API_KEY),
      llm_model_default: strip(process.env.LLM_MODEL) ?? "openai/gpt-4o-mini",
    },
    environment_variable_names: [
      "EXECUTION_BRIDGE_URL",
      "EXECUTION_BRIDGE_TOKEN",
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LLM_MODEL",
      "CONVEX_DEPLOYMENT",
      "VITE_CONVEX_URL",
      "VITE_CONVEX_SITE_URL",
    ],
  };
}

function strip(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t ? t : undefined;
}

/** Package versions are read from this module's own import graph metadata
 * where possible; a static, dependency-manifest-derived snapshot keeps this
 * module importable from both runtimes without node-specific APIs. */
function resolvePackageVersions(): { convex: string; react: string } {
  return { convex: "1.25.x (package.json)", react: "19.1.x (package.json)" };
}
