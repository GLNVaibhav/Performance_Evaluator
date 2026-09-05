# Product Workflow Contract: Intent → Compile → Approve → Execute → Result

**Status: documentation only, no new backend code.** An architecture
review (this document) found that `POST /api/v1/intents/compile`,
`POST /api/v1/runs`, `GET /api/v1/runs/{id}`, and
`GET /api/v1/runs/{id}/result` — all pre-existing, all unmodified —
already provide everything a client needs to build the complete intent →
result product workflow, with **zero schema translation**:
`IntentCompilationResponse.test_plan` is the exact same `TestPlan` type
`RunCreateRequest.plan` accepts. See
`backend/tests/test_workflow_intent_to_result.py` for the executable proof
of every claim in this document, run against the real k6 binary and the
real demo API.

## 1. Exact interaction sequence

```
POST /api/v1/intents/compile { UniversalPerformanceIntent }
        |
        v
    status?
        |
        +-- READY -----------------------------------------------+
        |       display response.test_plan for human review      |
        |       (VUs, duration, endpoints, endpoint_weights,      |
        |       thresholds, assumptions -- all already in the     |
        |       response body, no extra call)                    |
        |                                                         |
        |       [ HUMAN/CLIENT DECISION: approve? ]               |
        |                                                         |
        |       YES  -> POST /api/v1/runs                         |
        |               { "plan": <the same test_plan, verbatim>, |
        |                 "target": { "base_url": <chosen by      |
        |                              the client, not the        |
        |                              compiler> } }               |
        |               -> 201 { run_id, status: QUEUED }          |
        |                                                         |
        |               GET /api/v1/runs/{run_id}   (poll)        |
        |               -> { status: QUEUED|RUNNING|COMPLETED|    |
        |                     CANCELLED|EXECUTION_ERROR, ... }     |
        |                                                         |
        |               when COMPLETED:                           |
        |               GET /api/v1/runs/{run_id}/result           |
        |               -> TestResult (metrics, per_endpoint,      |
        |                   threshold_violations, plan,            |
        |                   target_base_url, artifacts)            |
        |                                                         |
        |       NO   -> discard. Nothing was created by            |
        |               compiling -- there is nothing to undo.     |
        +---------------------------------------------------------+
        |
        +-- NEEDS_CLARIFICATION -----------------------------------+
        |       display response.clarifications_needed             |
        |       ([{field, question}, ...])                         |
        |       collect answers, merge into the SAME intent object |
        |       (client-side; the backend holds no partial-intent  |
        |       session state), POST /intents/compile again        |
        +------------------------------------------------------------+
        |
        +-- INVALID -------------------------------------------------+
                display response.rejection_code / rejection_reason
                terminal for this intent as submitted -- the client
                must construct a different intent, not retry the
                same one
```

## 2. Contracts at each stage (as they actually exist in code today)

| Stage | Call | Request | Response (fields relevant to the workflow) |
|---|---|---|---|
| Compile | `POST /api/v1/intents/compile` | `UniversalPerformanceIntent` (`app/schemas/intent.py`) | `IntentCompilationResponse{status, intent, test_plan?, clarifications_needed?, rejection_code?, rejection_reason?}` |
| Approve + execute | `POST /api/v1/runs` | `RunCreateRequest{plan: TestPlan, target: TargetConfig}` (`app/schemas/run.py`) | `RunCreateResponse{run_id, status}` (201) |
| Poll | `GET /api/v1/runs/{id}` | — | `RunStatusResponse{run_id, status, created_at, started_at, finished_at, error_message}` |
| Result | `GET /api/v1/runs/{id}/result` | — | `TestResult{run_id, metrics (incl. per_endpoint), threshold_status, evaluated_at, target_base_url, plan, threshold_violations, artifacts}` |

## 3. Required state

- **Frontend/client state:** the current `UniversalPerformanceIntent` being built (so clarification answers can be merged back in and recompiled), the last `IntentCompilationResponse` (for plan preview), and — once execution is approved — the `run_id` (for polling and result retrieval). All of this is ordinary UI state; none of it needs to be persisted server-side between the compile and run steps, because the compile response is self-contained and the compiled plan is resubmitted verbatim.
- **Backend state:** none beyond what already exists — `TestPlanRecord`/`TestRunRecord`/`TestResultRecord`, created only by `POST /api/v1/runs`, never by `/intents/compile`. There is deliberately no "pending intent" or "session" table.

## 4. Transition rules

- `READY` → the ONLY state from which `POST /api/v1/runs` is meaningful (its `test_plan` is a fully-validated, submittable `TestPlan`).
- `NEEDS_CLARIFICATION` / `INVALID` → `test_plan` is `None`. There is structurally nothing for a client to submit to `/runs` — a client following the contract cannot accidentally execute an unready intent, because the field it would need doesn't exist in the response.
- Compiling is **idempotent and side-effect-free**: recompiling the same intent (e.g. after answering a clarification) is always safe to call repeatedly, including as a "recompile to double check" action, since it creates no server-side state (proven by `test_compiling_a_ready_intent_creates_no_run_and_touches_no_engine`).
- A `READY` compilation result does **not** guarantee the plan will execute successfully. The compiler validates structure and workload limits, but — by existing, documented design (`ai_intent_architecture.md` §13, "No OpenAPI-based endpoint validation") — it does not check `target_scope.endpoints` against the real target's actual OpenAPI surface. **Empirically confirmed during this review**: an intent naming a literal path like `/products/1` (rather than the target's real template `/products/{product_id}`) compiles to `READY`, is accepted by `/runs`, and only then fails with `EXECUTION_ERROR` ("selected_endpoints entry '/products/1' does not exist in the target's OpenAPI document"). A client must treat `EXECUTION_ERROR` as a real, expected outcome even after a `READY` compile — this is not a bug, it is the honest boundary of what compile-time validation can check without contacting the target.

## 5. Error boundaries

- `POST /api/v1/intents/compile`: `200` for every one of `READY`/`NEEDS_CLARIFICATION`/`INVALID` (all are successful *compilations*, differing only in outcome), `422` only for a request that fails Pydantic's own structural parsing (e.g. `error_rate > 1`, malformed `duration` syntax) — before `compile_intent()` ever runs.
- `POST /api/v1/runs`: `201` on success, `404` if `plan_id` doesn't exist, `422` if the plan (inline or referenced) exceeds workload limits.
- `GET /api/v1/runs/{id}`: `404` if the run doesn't exist.
- `GET /api/v1/runs/{id}/result`: `409` while `QUEUED`/`RUNNING` or if `CANCELLED` (not ready / no result), `422` if `EXECUTION_ERROR` (a real execution failure, not a performance result), `500` only if a `COMPLETED` run is somehow missing its result row (a backend bug, not a client error).

## 6. Retry behavior

- Compiling is safe to retry/repeat freely (idempotent, no state).
- `POST /api/v1/runs` is **not** idempotent — each call creates a new run. A client must not blindly retry a run-creation call on a network timeout without first checking whether a run was actually created (no idempotency key exists in the current contract; out of scope for this review since no gap was demonstrated requiring one — see "What was intentionally not implemented" below).
- Polling `GET /api/v1/runs/{id}` is always safe to retry.

## 7. What must never happen automatically

- **Compilation must never trigger execution.** Structurally enforced today: `app/api/routes_intents.py` imports only `compile_intent`; it has no import of `run_service`, `engine_provider`, or any DB write path. Proven directly by `test_compiling_a_ready_intent_creates_no_run_and_touches_no_engine`, which monkeypatches `get_performance_engine` into an assertion trap and confirms compiling a `READY` intent never trips it, and confirms zero new `TestRunRecord` rows.
- **A `NEEDS_CLARIFICATION` or `INVALID` result must never be treated as executable** — enforced by `test_plan` being `None` in both cases, not by client discipline alone.
- **The target (`base_url`) is never chosen by the compiler or the intent.** `TargetConfig` appears only in `test_plan.py` and `run.py`, never in `intent.py` — confirmed by inspection. A client must supply it explicitly at the `/runs` step, which is also where "where is this actually about to run" gets a final human-visible confirmation point.

## 8. What was evaluated and intentionally NOT built

| Option | Verdict | Why |
|---|---|---|
| **A — client orchestrates existing endpoints directly** | **Chosen.** | Every requirement (plan preview, clarification display, explicit approval, status polling, result display) is already satisfiable with the four existing endpoints and zero schema translation. |
| **B — thin workflow endpoint composing compile+run** | Rejected | Would only wrap "take this JSON field from response 1, put it in request 2" — no real computation to compose. Worse, a combined endpoint is structurally closer to the auto-execution risk this architecture explicitly forbids; the current two-call design is what makes the "compilation never executes" invariant enforceable by inspection rather than by convention. |
| **C — persistent workflow/session state** | Rejected | No demonstrated need: the compile response is already self-contained (echoes back the full intent alongside the compiled plan), so there's nothing for a session to hold that the client doesn't already have. Would be speculative infrastructure for a requirement that doesn't exist yet. |
| **D — no production change; tests + contract docs** | **Chosen** (alongside A). | This document and `tests/test_workflow_intent_to_result.py` are exactly that. |
