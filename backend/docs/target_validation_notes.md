# Target-Aware Pre-Execution Validation

**Status: implemented, additive, zero execution-core changes.** Closes a
proven gap: `compile_intent()` validates `target_scope.endpoints`
structurally only (leading slash, no scheme, no whitespace), never against
a real target's OpenAPI surface — so an intent naming `/products/1`
compiled `READY`, was accepted by `POST /api/v1/runs`, and only surfaced
as `EXECUTION_ERROR` after the run had already been created and
background execution had begun. Empirically confirmed before this work
(see the prior workflow review) and again as the worked example below.

## 1. Architecture inspection findings

- `app/schemas/intent.py` / `app/services/intent_compiler.py`: `compile_intent()`
  is a pure function — no I/O, no network, no target concept anywhere.
  `_validate_endpoints`'s own docstring already says "not a check against
  the target's actual OpenAPI surface."
- `app/schemas/run.py`: `RunCreateRequest{plan: TestPlan, target: TargetConfig}`
  — `target` (and therefore `base_url`) is the **first** point in the
  whole pipeline where a `TestPlan` and a real target are combined.
  `TargetConfig` does not exist anywhere in the intent layer.
- `app/services/run_service.py`: `create_run()` already has exactly one
  pre-persistence gate — `validate_workload_limits(plan)` — raising
  before anything is saved to the DB. This is the established pattern
  this work extends, not invents.
- OpenAPI/resolution mechanism — confirmed by repository search
  (`grep -rl "openapi" app/`), no duplicate parser exists:
  `app/services/k6_engine/openapi_loader.py` (`load_normalized`, network
  fetch + parse) and `app/services/k6_engine/endpoint_resolver.py`
  (`resolve_selected_endpoints`, exact-match against real path templates,
  raises `ResolutionError` naming the bad entry). `RealK6PerformanceEngine.execute()`
  already calls both of these today, inside the background execution
  task, *after* a run is already `QUEUED` — confirmed from
  `app/services/k6_engine/engine.py`'s `_PRE_EXECUTION_ERRORS` handling.
  Note this already means the k6 **subprocess** itself was never invoked
  for this case (`run_k6()` is never reached) — the actual gap is not "k6
  runs uselessly," it's "the run is already created and the client is
  already polling before the incompatibility is known."

## 2. Question A — where should `/products/1` be rejected?

| Option | Verdict |
|---|---|
| 1. Inside `POST /intents/compile` | **Rejected.** Requires `compile_intent()` to know a `base_url` — but `UniversalPerformanceIntent` deliberately has no target concept (explicit prior architectural decision), and this would make compilation network-dependent, target-dependent, and non-deterministic. Violates the intent/compilation/execution layer separation directly. |
| 2. A target-aware stage after compilation, before execution | **This is the shape chosen** — see §3. |
| 3. Inside `POST /runs`, before persistence | **Chosen concretely** — same endpoint, extends the existing `validate_workload_limits` gate pattern exactly. |
| 4. A new `POST /plans/validate-target` endpoint | **Rejected as a separate surface**, though its *logic* is fully reusable if ever wanted: no demonstrated need for a client to check compatibility without also being willing to create the run — folding it into `/runs` closes the gap at the earliest point that already exists, with zero new API surface. |

## 3. Question B — can this be `TestPlan -> ValidateAgainstTarget -> Execute` without changing `compile_intent()`'s meaning?

**Yes, exactly as implemented.** `compile_intent()` is untouched, byte for
byte. The new check operates purely on an already-compiled `TestPlan` (or
any hand-authored one submitted directly to `/runs` — it applies
uniformly, like workload limits) plus the `TargetConfig` that `/runs`
already required. This doesn't blur compile vs. execute — it's a new gate
at the one place those two concepts already first meet.

## 4. Question C — state model when compile = READY but target validation fails

**No new `IntentStatus` value was added** (explicitly out of scope, and
unnecessary): `IntentStatus.READY` still means exactly what it always
meant — "compiles to a structurally/semantically valid `TestPlan`" — full
stop, unchanged. Target compatibility is answered one layer later, at
`/runs`, using the **same HTTP status code family already established**
for plan-level rejections (`422`, matching `WorkloadLimitExceededError`),
but a **distinct exception type** (`TargetValidationError`) and a message
that names the specific bad endpoint — giving callers a clear, mechanical
way to distinguish "plan is invalid" (`PlanNotFoundError` -> 404,
`WorkloadLimitExceededError` -> 422) from "plan is fine, but incompatible
with *this* target" (`TargetValidationError` -> 422, endpoint named in the
message) without inventing a parallel enum universe.

## 5. Question D — should validation perform network access?

**Yes, necessarily, and deliberately not inside `compile_intent()`.**
"Does this endpoint exist on this target" is inherently target-dependent
and requires fetching that target's real `/openapi.json` — there is no
way to answer it without a network call, which is exactly *why* it
belongs at `/runs` (where a target already must be supplied) and not in
compilation (which must stay pure). This is a deliberate, accepted
latency cost: `POST /runs` now blocks on one HTTP round-trip to the
target before returning. Measured: full backend suite runtime went from
~90s to ~135–180s after this change, entirely attributable to this extra
call across the many tests that create runs. For a local/demo target this
is milliseconds per call; for a slow or distant real target it would be
more material — a real product concern, not hidden here (§7).

## 6. The deliberate asymmetry (the actual design decision, not just placement)

Initial design (validate + always reject if the fetch fails OR the
endpoint is missing) was checked against the **existing** test suite
before being finalized, per this task's own discipline
("do not trust previous reports blindly" applies to one's own untested
reasoning too). Numerous existing tests (`test_result_retrieval.py`,
`test_failure_semantics.py`, `test_endpoint_intelligence_persistence.py`,
`test_intent_routes.py`) deliberately submit `target.base_url =
"http://127.0.0.1:1"` (a guaranteed-unreachable, fast-failing sentinel
port) to `create_run`, specifically because today nothing ever contacts
the target until background execution — they're testing the run
lifecycle/persistence/workload-limits, not real target reachability.

Rather than "fix" (rewrite) all of those tests to use a live target, the
validator was designed with an intentional asymmetry, verified as the
more *correct* semantic choice on its own merits, not just as a
convenient way to avoid touching tests:

- **Target unreachable / OpenAPI document unfetchable → does NOT raise.**
  You cannot assert incompatibility with a target you couldn't even
  check — treating "couldn't verify" as "reject" would be a
  false-negative machine, not a real verdict. This case is deferred to
  `execute_run`, completely unchanged from before this work.
- **Target reachable AND the endpoint demonstrably absent from its real
  surface → DOES raise.** This is the one case with positive evidence,
  and is exactly the proven gap.

Consequence, confirmed empirically, not assumed: **zero existing tests
required modification.** Full backend suite before this change: 202
passed, 1 skipped. After: 212 passed (202 + 10 new), 1 skipped (same
pre-existing, unrelated skip) — identical baseline, purely additive.

## 7. Known limitation / accepted risk

`RealK6PerformanceEngine.execute()` still independently calls
`load_normalized()` + endpoint resolution itself during background
execution (unchanged, not touched). This means a valid, accepted run
fetches the target's OpenAPI document **twice** — once for this
pre-persistence gate, once again for real execution. This was a
deliberate tradeoff: avoiding the double-fetch would mean threading a
cached `NormalizedOpenAPI` from `run_service` into
`RealK6PerformanceEngine.execute()`, changing the `PerformanceEngine`
Protocol or `RunService`'s internals — both explicitly protected without
an overwhelming justification. For a local/demo target the cost is
negligible; documented here rather than silently accepted.
