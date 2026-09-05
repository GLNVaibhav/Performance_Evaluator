# Real LLM Intent Interpreter

**Status: implemented, additive, zero execution-core changes.** Second
real implementation of the existing `IntentInterpreter` Protocol
(`app/services/intent_interpreter.py`, untouched), alongside
`DeterministicIntentInterpreter` (also untouched).

## 1. Inspection findings

Confirmed by direct inspection before writing any code: `IntentInterpreter`
is a plain `typing.Protocol` with one method; `InterpretationResult`/
`InterpretationStatus` already exist and were reused verbatim (not
modified, not duplicated); `UniversalPerformanceIntent` already exists and
is the exact schema the LLM's output is validated against; no LLM/OpenAI/
Anthropic/dotenv code existed anywhere in the repo (`grep`-confirmed); no
`.env`/`.env.example` existed; `requirements.txt` already includes
`httpx==0.28.1`; `TestType` enum is `baseline | soak | stress` only
(inspected, not assumed, and fed to the system prompt verbatim from the
enum rather than hardcoded); the demo API's real OpenAPI surface
(`/products`, `/products/{product_id}`, `/categories`,
`/categories/{category_id}`, `/cart`, `/checkout`) was re-confirmed live.

## 2. Provider chosen and why

**Plain `httpx` against any OpenAI-compatible `/chat/completions` endpoint
-- no `openai` SDK, no new dependency at all.** `httpx` is already a
required dependency; the OpenAI chat-completions request/response shape is
a well-defined, stable JSON contract that dozens of providers (OpenAI
itself, Groq, OpenRouter, local servers) implement identically. This
satisfies "one reliable provider integration," "do not require multiple
SDKs," and "minimum necessary dependency" simultaneously -- the minimum
necessary dependency turned out to be zero new ones.

## 3. Provider boundary design

```
app/services/intent_interpreter.py      <- UNCHANGED: Protocol, InterpretationResult, InterpretationStatus, DeterministicIntentInterpreter
app/services/llm_intent_interpreter.py  <- NEW: LLMIntentInterpreter (implements the same Protocol)
app/services/interpreter_provider.py    <- NEW: single wiring point, mirrors engine_provider.py exactly
app/api/routes_intents.py               <- extended: POST /interpret, POST /interpret-and-compile
app/core/config.py                      <- extended: LLM_API_KEY / LLM_MODEL / LLM_BASE_URL / LLM_TIMEOUT_S / LLM_KNOWN_ENDPOINTS
```

`LLMIntentInterpreter` imports only `httpx`, `pydantic`, and the existing
`intent_interpreter`/`intent` schema modules. It does **not** import
`compile_intent`, `run_service`, `engine_provider`, or anything under
`k6_engine/` -- confirmed by the file's own import list and by
`test_interpret_never_touches_run_service_performance_engine_or_k6`.

## 4. API endpoint contract

`POST /api/v1/intents/interpret`
```
Request:  { "user_input": "<natural language>" }
Response: InterpretationResult { status, intent, reason }
```
Never compiles, never executes. `POST /api/v1/intents/compile` remains
the sole authority from a structured intent to a `TestPlan`.

`POST /api/v1/intents/interpret-and-compile` (thin convenience, optional
per the brief, built anyway since it's a ~10-line composition):
```
Request:  { "user_input": "<natural language>" }
Response: { "interpretation": InterpretationResult, "compilation": IntentCompilationResponse | null }
```
`compilation` is `null` whenever `interpretation.intent` is `null`
(AMBIGUOUS/INVALID/INTERPRETATION_FAILURE) -- no compiler logic is
duplicated, this is exactly `interpret()` then, conditionally, the same
`compile_intent()` every other path uses. **Neither endpoint ever calls
`POST /api/v1/runs` or touches `RunService`.**

## 5. Structured output validation strategy

```
LLM HTTP response
  -> strip an optional markdown code fence (defensive; response_format
     should prevent this, not every provider honors it)
  -> json.loads                                    malformed  -> INTERPRETATION_FAILURE
  -> InterpretationStatus(parsed["status"])         unrecognized -> INTERPRETATION_FAILURE
  -> reject if status == INTERPRETATION_FAILURE itself (that value is
     reserved for THIS layer's own provider-failure detection, never
     trusted from the model)
  -> UniversalPerformanceIntent.model_validate(intent)   <- the EXISTING
     schema, not a parallel one              invalid field/type -> INTERPRETATION_FAILURE
  -> endpoint-containment check (see §6)      unknown endpoint  -> INTERPRETATION_FAILURE
  -> InterpretationResult
```
No value is ever silently repaired or defaulted at any stage.

## 6. Endpoint-context / hallucination containment

`available_endpoints` is injected at construction
(`interpreter_provider.py` wires it from `config.LLM_KNOWN_ENDPOINTS`,
itself sourced from the demo API's real, live-verified OpenAPI paths) --
the `IntentInterpreter` Protocol itself was **not** modified; this is a
constructor parameter of the concrete class only, per the brief's explicit
preference. The system prompt tells the model this is a closed set it
must select from. That instruction is **not trusted alone**: after
validation, every `target_scope.endpoints` entry is checked against the
configured set; any entry outside it maps the whole result to
`INTERPRETATION_FAILURE` (a model-reliability failure, not a user-intent
classification) rather than silently passing an invented path through --
proven by `test_endpoint_outside_known_set_is_rejected_not_passed_through`.
This directly contains the previously-proven "READY compiles, but the
endpoint doesn't exist on the real target" failure mode at the earliest
possible boundary, without redesigning the compiler (out of scope here,
and `backend/docs/target_validation_notes.md`'s gate still independently
guards this even if the interpreter check were ever bypassed).

## 7. Failure handling

Every one of: timeout, connection failure, invalid API key (non-2xx
status), provider unavailable, rate limiting (also non-2xx), malformed
JSON, and schema-invalid output maps to `INTERPRETATION_FAILURE` with a
descriptive `reason`, `intent=None`. The backend never crashes -- every
exception in the provider-call path is caught in `interpret()`'s own
`try/except Exception`. No failure path imports or can reach
`compile_intent`, `RunService`, `PerformanceEngine`, or k6 -- proven by
`test_interpret_never_touches_run_service_performance_engine_or_k6`.

## 8. Frontend handoff contract

```
STEP 1  User writes natural language.
STEP 2  POST /api/v1/intents/interpret  { "user_input": "..." }
STEP 3  Render the AI interpretation from the response directly:
          status                         -> badge (COMPLETE/INCOMPLETE/AMBIGUOUS/INVALID/INTERPRETATION_FAILURE)
          intent.test_type               -> "Test Type"
          intent.load_profile.*          -> "Users"
          intent.duration                -> "Duration"
          intent.target_scope.endpoints  -> "Endpoints"
          intent.target_scope.endpoint_weights -> "Traffic Distribution"
          intent.success_criteria.*      -> "Performance Thresholds"
          reason                         -> shown for AMBIGUOUS/INVALID/INTERPRETATION_FAILURE
STEP 4  If intent is non-null, POST the SAME intent object, verbatim, to
        POST /api/v1/intents/compile
STEP 5  Render: AI Interpretation -> Universal Intent -> Deterministic
        Compiler -> Executable Test Plan, using compile response's
        test_plan / clarifications_needed / rejection_reason exactly as
        the existing (pre-LLM) compile UI already does -- no new fields
        needed on that side, this work didn't touch it.
STEP 6  User explicitly approves (a real UI action, not automatic).
STEP 7  POST /api/v1/runs { "plan": <test_plan from step 5>, "target": {...} }
STEP 8  Poll GET /api/v1/runs/{id}, then GET /api/v1/runs/{id}/result for
        real k6 results, unchanged from the existing workflow contract
        (backend/docs/workflow_contract.md).
```
Steps 4-8 are **completely unchanged** from the pre-LLM workflow -- the
LLM only replaces how step 1's text becomes the intent object used from
step 4 onward. A frontend already built against the deterministic
interpreter's output shape needs zero changes to consume the LLM's.

## 9. Architecture invariants verified

1. LLM != Compiler -- `compile_intent()` untouched, never imported by the LLM interpreter.
2. LLM != Executor -- no import of `run_service`/`engine_provider`/k6_engine anywhere in `llm_intent_interpreter.py`.
3. LLM cannot bypass `compile_intent()` -- `/interpret` never calls it; `/interpret-and-compile` calls the real, same function.
4/5/6. Cannot invoke RunService/PerformanceEngine/k6 -- proven by assertion-trap tests.
7. Provider failures cannot reach execution -- `INTERPRETATION_FAILURE` always carries `intent=None`, and nothing downstream ever sees it.
8. `DeterministicIntentInterpreter` untouched, its 7 existing tests still pass unmodified.
9/10. Compiler/execution behavior unchanged -- full regression suite: 236 passed (212 previous + 24 new), 1 pre-existing skip, identical to before.
11. Human approval still required before `POST /runs` -- neither new endpoint calls it.

## 10. Known limitations

- No real provider was called during this implementation session (no API
  key available in this environment) -- the pipeline is proven correct
  against every response shape a real provider could plausibly return
  (valid, malformed, schema-invalid, non-2xx, timeout), via
  `httpx.MockTransport` exercising the real request-building and parsing
  code, but the live end-to-end demonstration in the task report requires
  the user to supply `LLM_API_KEY`.
- `response_format: {"type": "json_object"}` is sent on every request;
  providers that reject unknown request fields entirely (rare among
  OpenAI-compatible ones) would need that removed -- not encountered, not
  handled specially.
- No retry/backoff on transient provider failures -- a single failure is
  a single `INTERPRETATION_FAILURE`; acceptable for an interpretation
  step a human reviews before anything executes, called out explicitly
  rather than silently absent.
