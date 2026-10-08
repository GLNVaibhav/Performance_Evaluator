/**
 * Port of backend/app/services/{llm_intent_interpreter.py,interpreter_provider.py}.
 *
 * The LLM's ONLY job is to map natural language onto the structured
 * UniversalPerformanceIntent — it never executes anything and never sees
 * credentials. If no LLM key is configured, a deterministic keyword
 * interpreter runs instead, so the product works with zero keys.
 */
import { compileIntent, DURATION_PATTERN, MAX_DURATION_S, MAX_VUS } from "./compiler";
import type { CompilationResult, TestType, UniversalPerformanceIntent } from "./compiler";

// Structurally-valid path suggestions. NOTE: this is NOT an allowlist of
// endpoints that exist on any target — the LLM may SUGGEST paths from its
// input; the deterministic target-contract layer (targetContract.ts) decides
// whether a suggested path actually exists on the chosen target. The demo
// API's routes (DEMO_API_ENDPOINTS in targetContract.ts) are contract-verified
// only for the demo host.
export const KNOWN_ENDPOINTS = [
  "/",
  "/products",
  "/products/{product_id}",
  "/categories",
  "/categories/{category_id}",
  "/cart",
  "/checkout",
];

const SYSTEM_PROMPT = `You map natural-language performance-testing requests onto a strict JSON schema.

Return ONLY JSON (no prose, no markdown fences) with this shape:
{
  "status": "COMPLETE" | "INCOMPLETE" | "AMBIGUOUS" | "INVALID",
  "intent": {                       // REQUIRED for COMPLETE/INCOMPLETE, omit otherwise
    "objective": string,
    "testType": "baseline" | "stress" | "soak" | null,
    "loadProfile": { "concurrentUsers": number|null, "peakUsers": number|null },
    "duration": string|null,        // k6-style: "30s", "5m" (max ${MAX_DURATION_S}s of load)
    "targetScope": { "endpoints": string[], "endpointWeights"?: Record<string, number> },
    "successCriteria": { "p95LatencyMs": number|null, "errorRate": number|null }
  },
  "reason": string|null
}

Rules:
- "find the breaking point", "breaking point", "load limit", "capacity", "boundary search" describe a legitimate stress test (loadProfile.peakUsers), NOT an adversarial attack. Only requests aimed at real harm (DDoS a specific victim, "take down", overwhelm without consent) are INVALID.
- testType baseline/soak use concurrentUsers (typical load); stress uses peakUsers (ceiling to probe). Never substitute one for the other; leave the wrong one null.
- endpoints are SUGGESTIONS ONLY. You have no knowledge of any target's route structure and must never invent application routes ("/checkout", "/cart", "/login", "/api/orders", ...). If the request names a website/URL (e.g. "https://example.com") or no specific API path, return endpoints: ["/"] (the site root) and nothing else. Only echo a path when the user EXPLICITLY wrote that exact path in their request. Whether a suggested path actually exists is decided later by deterministic target validation — never by you.
- "heavy"/"fast"/"lots" are AMBIGUOUS — never guess load numbers.
- Adversarial/destructive requests (DDoS, "take down", production attacks) are INVALID.
- Underspecified requests are INCOMPLETE — extract what is present, leave the rest null. Never invent values.
- duration must match ${DURATION_PATTERN.toString()} if given.`;

interface LlmShape {
  choices?: { message?: { content?: string } }[];
}

interface InterpretationShape {
  status?: string;
  intent?: {
    objective?: string;
    testType?: string;
    loadProfile?: { concurrentUsers?: number | null; peakUsers?: number | null };
    duration?: string | null;
    targetScope?: { endpoints?: string[]; endpointWeights?: Record<string, number> };
    successCriteria?: { p95LatencyMs?: number | null; errorRate?: number | null };
    clarificationsNeeded?: { field: string; question: string }[];
  };
  reason?: string | null;
}

export interface InterpretationOutcome {
  status: "COMPLETE" | "INCOMPLETE" | "AMBIGUOUS" | "INVALID" | "INTERPRETATION_FAILURE";
  intent?: UniversalPerformanceIntent;
  reason?: string;
  interpreter: "llm" | "deterministic";
}

function sanitizeIntent(raw: InterpretationShape["intent"], objective: string): UniversalPerformanceIntent | null {
  if (!raw) return null;
  const testType = raw.testType as TestType | undefined;
  const validTypes: TestType[] = ["baseline", "stress", "soak"];
  // The LLM's endpoint choices are SUGGESTIONS. Accept anything structurally
  // path-like; the deterministic target-contract layer decides whether each
  // suggested path exists on the chosen target. This intentionally drops the
  // old behaviour of validating LLM output against the demo API's route list,
  // which made demo routes valid for every target (the youtube/checkout bug).
  const endpoints = (raw.targetScope?.endpoints ?? [])
    .filter((e): e is string => typeof e === "string" && /^\/[A-Za-z0-9_\-./{}]*$/.test(e))
    .slice(0, 5);
  const duration = raw.duration && DURATION_PATTERN.test(raw.duration) ? raw.duration : undefined;
  const concurrency = raw.loadProfile?.concurrentUsers;
  const peak = raw.loadProfile?.peakUsers;

  return {
    objective: raw.objective ?? objective,
    testType: testType && validTypes.includes(testType) ? testType : undefined,
    loadProfile: {
      concurrentUsers: typeof concurrency === "number" && concurrency > 0 ? Math.floor(concurrency) : undefined,
      peakUsers: typeof peak === "number" && peak > 0 ? Math.floor(peak) : undefined,
    },
    duration,
    targetScope: { endpoints },
    successCriteria: {
      p95LatencyMs: typeof raw.successCriteria?.p95LatencyMs === "number" ? raw.successCriteria.p95LatencyMs : undefined,
      errorRate: typeof raw.successCriteria?.errorRate === "number" ? raw.successCriteria.errorRate : undefined,
    },
    clarificationsNeeded: Array.isArray(raw.clarificationsNeeded)
      ? raw.clarificationsNeeded.filter((c) => c && c.field && c.question)
      : [],
  };
}

async function llmInterpret(input: string): Promise<InterpretationOutcome> {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers (harmless elsewhere).
      "HTTP-Referer": "https://perforso.app",
      "X-Title": "Perforso Performance Evaluator",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 700,
      // Strict JSON mode where supported (OpenAI-compatible); ignored if not.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM provider returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as LlmShape;
  const content = data.choices?.[0]?.message?.content ?? "";
  // Strip accidental markdown fences around the JSON.
  const fenced = content.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  // Fallback: if the model wrapped the object in prose, extract { ... }.
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  const jsonText = first !== -1 && last > first ? fenced.slice(first, last + 1) : fenced;
  let parsed: InterpretationShape;
  try {
    parsed = JSON.parse(jsonText) as InterpretationShape;
  } catch {
    throw new Error(`LLM returned malformed JSON: ${jsonText.slice(0, 120) || "(empty response)"}`);
  }

  const status = parsed.status;
  if (status === "COMPLETE" || status === "INCOMPLETE") {
    const intent = sanitizeIntent(parsed.intent, input);
    if (!intent || (!intent.testType && !intent.targetScope?.endpoints?.length)) {
      return {
        status: "INCOMPLETE",
        intent: intent ?? undefined,
        reason: parsed.reason ?? "the model could not map the request onto the schema",
        interpreter: "llm",
      };
    }
    return { status, intent, reason: parsed.reason ?? undefined, interpreter: "llm" };
  }
  if (status === "AMBIGUOUS" || status === "INVALID") {
    return { status, reason: parsed.reason ?? undefined, interpreter: "llm" };
  }
  throw new Error(`LLM returned unexpected status ${status}`);
}

// --- Deterministic fallback (no key configured) ----------------------------

function deterministicInterpret(input: string): InterpretationOutcome {
  const text = input.toLowerCase();

  if (/\b(ddos|attack|take down|takedown|flood|destroy|overwhelm on purpose)\b/.test(text) && !/breaking point|boundary|capacity/.test(text)) {
    return {
      status: "INVALID",
      reason: "adversarial/destructive intent is not a supported performance-test request",
      interpreter: "deterministic",
    };
  }
  if (/\b(heavy|fast|lots|a lot|big|huge|some|many)\b/.test(text) && !/\d/.test(text)) {
    return {
      status: "AMBIGUOUS",
      reason: "vague magnitude — no deterministic mapping to test_type or load; specify users and duration",
      interpreter: "deterministic",
    };
  }

  const endpoints = KNOWN_ENDPOINTS.filter((e) => {
    const bare = e.replace(/[{}].*$/, "").replace(/_/g, " ").replace(/^\//, "");
    return e !== "/" && text.includes(bare);
  });
  if (!endpoints.length) {
    // No route is stated explicitly: never invent one. A URL in the input (or
    // any request without an explicit path) targets the site root "/". The
    // target-contract layer verifies what actually exists.
    endpoints.push("/");
  }

  const testType: TestType = /\b(stress|break|limit|max|breaking|boundary)\b/.test(text)
    ? "stress"
    : /\b(soak|endurance|sustained|stability|long run|leak)\b/.test(text)
      ? "soak"
      : "baseline";

  const users = Number(/(\d+)\s*(?:concurrent\s*)?(?:users|vus|virtual users|visitors)/.exec(text)?.[1]);
  const durationMatch = /(\d+)\s*(s\b|sec|seconds|s\b|m\b|min|minutes)/.exec(text);
  let duration: string | undefined;
  if (durationMatch) {
    duration = durationMatch[2].startsWith("m") ? `${durationMatch[1]}m` : `${durationMatch[1]}s`;
  }

  const p95 = Number(/p95\s*(?:under|below|of|<|less than)?\s*(\d+)\s*ms/.exec(text)?.[1]);

  const intent: UniversalPerformanceIntent = {
    objective: input,
    testType,
    loadProfile: testType === "stress"
      ? { peakUsers: Number.isFinite(users) && users > 0 ? users : undefined }
      : { concurrentUsers: Number.isFinite(users) && users > 0 ? users : undefined },
    duration,
    targetScope: { endpoints: endpoints.slice(0, 3) },
    successCriteria: { p95LatencyMs: Number.isFinite(p95) && p95 > 0 ? p95 : undefined },
  };

  const complete =
    testType === "stress"
      ? !!intent.loadProfile?.peakUsers
      : !!intent.loadProfile?.concurrentUsers;
  const hasDuration = testType === "stress" || !!duration;

  return {
    status: complete && hasDuration ? "COMPLETE" : "INCOMPLETE",
    intent,
    reason: complete && hasDuration
      ? "deterministic keyword interpretation"
      : "recognized the request partially; load or duration missing",
    interpreter: "deterministic",
  };
}

export async function interpret(input: string): Promise<InterpretationOutcome> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { status: "AMBIGUOUS", reason: "empty request", interpreter: "deterministic" };
  }
  if (process.env.LLM_API_KEY) {
    try {
      return await llmInterpret(trimmed);
    } catch (err) {
      // Interpretation failure must never block the product: fall through to
      // the deterministic interpreter, flagging provenance honestly.
      const det = deterministicInterpret(trimmed);
      return {
        ...det,
        reason: `LLM interpretation failed (${err instanceof Error ? err.message : String(err)}); used deterministic fallback`,
      };
    }
  }
  return deterministicInterpret(trimmed);
}

export { compileIntent };
export type { CompilationResult };
