/**
 * Target contract + endpoint validation — the deterministic layer between
 * intent and plan (architecture: NL → Intent → TARGET CONTRACT → ENDPOINT
 * VALIDATION → Deterministic TestPlan → Execution).
 *
 * The LLM may suggest endpoints; this layer decides whether they exist.
 * The LLM is never proof an endpoint exists.
 *
 * Classification:
 *   A. Authorized API with a known contract (the bundled demo API) → contract
 *      routes are verified by contract; the full k6 execution plane applies.
 *   B. Any other explicitly-provided URL → no application-route assumptions;
 *      only the site root "/" is contract-free, every other suggested path
 *      must be verified by a bounded GET (2xx/3xx = exists; 4xx/5xx/network
 *      = NOT verified — 404 means "path not established", never "a valid
 *      business endpoint is failing").
 *
 * Verification spends at most one bounded GET per non-root candidate path,
 * never a load run — it is pre-flight, not testing.
 */

import { compileIntent, ENDPOINT_PATTERN } from "./compiler";
import type { CompilationResult, UniversalPerformanceIntent } from "./compiler";
import { probeUrlSet, timedFetchWithRedirects } from "./probe";
import type { ProbeDeps } from "./probe";

void ENDPOINT_PATTERN; // re-exported for consumers of the target-contract module

/** The demo API's documented route contract (host-scoped, not global). */
export const DEMO_API_ENDPOINTS = [
  "/",
  "/products",
  "/products/{product_id}",
  "/categories",
  "/categories/{category_id}",
  "/cart",
  "/checkout",
];

/** Hosts whose documented contract ships with the product (the demo API). */
const DEMO_API_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "demo-api.freebuff.app",
  "demo-api.perforso.dev",
  "[::1]",
]);

export type TargetClass = "contract_api" | "arbitrary_url";

export interface EndpointVerification {
  endpoint: string;
  verified: boolean;
  /** HTTP status of the verification GET; null when no response was received. */
  status: number | null;
  /** Null when verified; short reason otherwise ("no_contract", "404", "500", "network", ...). */
  reason: string | null;
  /** Network-level error text from the verification GET, when any. */
  errorSample?: string;
}

export interface TargetContractResult {
  targetClass: TargetClass;
  baseUrl: string;
  verifications: EndpointVerification[];
  /** true = all verified; false = none verified; null = partially verified. */
  allVerified: boolean | null;
}

/** Overall wall-clock budget for endpoint verification GETs. */
const VERIFICATION_TIMEOUT_MS = 10_000;

export function classifyTarget(baseUrl: string): TargetClass {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "arbitrary_url";
  }
  const host = url.hostname.toLowerCase();
  return DEMO_API_HOSTS.has(host) ? "contract_api" : "arbitrary_url";
}

export async function verifyTargetEndpoints(
  baseUrl: string,
  endpoints: string[],
  deps: ProbeDeps = {},
): Promise<TargetContractResult> {
  const targetClass = classifyTarget(baseUrl);
  // "/" is the site root and is contract-free for every target; it is never
  // GET-verified (the execution-time probe establishes reachability anyway).
  const toVerify = endpoints.filter((e) => e !== "/");
  const verifications: EndpointVerification[] = [];
  const deadline = deps.now ? null : Date.now() + VERIFICATION_TIMEOUT_MS;

  if (targetClass === "contract_api") {
    for (const e of toVerify) {
      const known = DEMO_API_ENDPOINTS.includes(e);
      verifications.push({
        endpoint: e,
        verified: known,
        status: known ? 200 : null,
        reason: known ? null : "no_contract",
      });
    }
    return { targetClass, baseUrl, verifications, allVerified: true };
  }

  // Arbitrary URL: every non-root path must be established by a real GET.
  for (const e of toVerify) {
    if (deadline !== null && Date.now() > deadline) {
      verifications.push({ endpoint: e, verified: false, status: null, reason: "timeout" });
      continue;
    }
    const urls = probeUrlSet(baseUrl, [e]);
    const outcome = await timedFetchWithRedirects(urls[0]!, deps);
    if (outcome.error) {
      verifications.push({
        endpoint: e,
        verified: false,
        status: null,
        reason: "network",
        errorSample: outcome.error,
      });
    } else {
      const ok = outcome.status >= 200 && outcome.status < 400;
      verifications.push({
        endpoint: e,
        verified: ok,
        status: outcome.status,
        reason: ok ? null : `${outcome.status}`,
      });
    }
  }

  const allVerified = verifications.every((v) => v.verified)
    ? true
    : verifications.some((v) => v.verified)
      ? null
      : false;
  return { targetClass, baseUrl, verifications, allVerified };
}

export function endpointVerificationSummary(v: EndpointVerification[]): string {
  const failed = v.filter((x) => !x.verified);
  if (!failed.length) return "";
  return failed
    .map((f) => (f.status !== null ? `${f.endpoint} → HTTP ${f.status}` : `${f.endpoint} → no response (${f.reason})`))
    .join(", ");
}

/**
 * Compile + endpoint-validation gate for the interpret→compile pipeline.
 * READY only when the plan compiles AND every non-root endpoint is verified
 * against the target. Unverified paths → NEEDS_CLARIFICATION naming the
 * paths (the reviewer can drop them and keep the verified site root).
 * Never executes anything.
 */
export async function compileIntentWithTargetContract(
  intent: UniversalPerformanceIntent,
  baseUrl: string,
  deps: ProbeDeps = {},
): Promise<CompilationResult & { targetContract?: TargetContractResult }> {
  const base = compileIntent(intent);
  if (base.status !== "READY") return base;

  const endpoints = base.plan?.selectedEndpoints ?? [];
  const contract = await verifyTargetEndpoints(baseUrl, endpoints, deps);

  const unverified = contract.verifications.filter((v) => !v.verified);
  if (unverified.length) {
    const summary = endpointVerificationSummary(contract.verifications);
    return {
      status: "NEEDS_CLARIFICATION",
      intent,
      clarificationsNeeded: [
        {
          field: "target_scope.endpoints",
          question:
            `The target ${baseUrl} did not verify these path(s): ${summary}. ` +
            `No API contract is available for this target, so the path(s) could not be established as valid application/API operations. ` +
            `Proceed with the site root "/" only, or provide a target that actually serves these path(s).`,
        },
      ],
      targetContract: contract,
      rejectionCode: "unverified_endpoints",
      rejectionReason: summary,
    };
  }
  return { ...base, targetContract: contract };
}
