# Performance Engine Interface

**Status: frozen for MVP integration** (reviewed by Dev-3). `TestPlan`
(`app/schemas/test_plan.py`) is the central contract of the whole system —
`boundary_search` means one VU-level experiment, `fixed_load` means one
fixed workload. Neither is ever a multi-stage stress ladder inside a
single k6 invocation.

This is the contract between the backend (Developer 1) and the performance
engine (Developer 2: k6 script templating, schema-aware payload generation,
subprocess execution, metrics analysis). The backend depends only on this
interface, defined in `app/services/performance_engine.py`. Do not change
this interface for a hypothetical need — only for a genuine blocking
incompatibility discovered while integrating the real engine.

```python
class PerformanceEngine(Protocol):
    def execute(
        self,
        plan: TestPlan,
        target: TargetConfig,
        artifact_directory: Path,
    ) -> EngineExecutionOutcome: ...
```

- `plan` — a validated `TestPlan` (`app/schemas/test_plan.py`): either
  `BoundarySearchPlan` (single `target_vus`, `ramp_duration` + `hold_duration`)
  or `FixedLoadPlan` (single `target_vus`, `duration`). Never JavaScript.
- `target` — currently just `{ base_url: str }`. No auth in Phase 1.
- `artifact_directory` — a directory the backend has already created and
  uniquely owns for this run (`artifacts/<run_id>/`). The engine should
  write whatever it needs here (rendered script, raw k6 output, k6 summary,
  logs) and reference those paths back in the outcome. The backend does not
  clean this up or inspect its contents beyond the paths returned.

## Return contract: `EngineExecutionOutcome`

```python
class EngineExecutionOutcome(BaseModel):
    exit_code: int
    summary_exists: bool
    metrics: Optional[MetricsSummary] = None
    threshold_status: Optional[ResultClassification] = None
    raw_output_path: Optional[str] = None
    summary_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None
    started_at: datetime
    finished_at: datetime
    error_message: Optional[str] = None
```

## The one rule that actually matters: execution failure vs. performance failure

**Amended by the Dev-3 gate review (BLOCKER 2, commit `585a177`).** The
original version of this doc said a present results artifact was a
legitimate result "even if `exit_code != 0`". That was wrong and has been
fixed in the real engine: a non-zero k6 exit code is *always* an execution
failure, full stop — a `results.json` that happens to exist on disk (e.g.
from a script/runtime error partway through, or the process being killed
after partially flushing output) never overrides a failed process.

The backend (`run_service.execute_run`) branches on this outcome exactly one way:

- **`exit_code == 0` and a usable results artifact exists** → the engine
  parses metrics and evaluates thresholds, returning `summary_exists=True`
  with `metrics` and `threshold_status` set. This is a legitimate
  performance result, whether `threshold_status` comes out `PASS` or
  `FAIL`. `TestRun` → `COMPLETED`, a `TestResult` row is persisted with
  whatever `threshold_status` you give.
- **anything else** — `exit_code != 0` (regardless of whether a results
  artifact exists), a missing/malformed results artifact, or the engine
  raises — → `summary_exists=False`, `metrics=None`, `threshold_status=None`.
  Treated as an actual execution failure. `TestRun` → `EXECUTION_ERROR`,
  `error_message` is stored, **no** `TestResult` is created. This must
  never be reinterpreted as a performance `FAIL` — the adaptive
  boundary-search engine (Phase 2) only ever sees clean PASS/FAIL results
  and would corrupt its search on a swallowed execution error.

Concretely: if k6 fails to start, the script has a syntax error, the
process exits non-zero for any reason (including a crossed k6-native
threshold, if one is ever configured), the target is unreachable before
any requests complete, or the process times out — return
`summary_exists=False` with `error_message` explaining why (or just raise;
the backend catches it and records the message). Only return
`summary_exists=True` when the process exited `0` *and* you have real
metrics to report.

## `threshold_status` is yours to compute, but must be deterministic

PASS/FAIL must never come from an LLM and must never be hardcoded by the
backend — the backend just persists whatever `threshold_status` the engine
returns. Compare `plan.thresholds` (`p95_latency_ms`, `error_rate`) against
your computed metrics using plain arithmetic.

## Canonical MVP result artifact: k6 summary-export (frozen)

The frozen MVP execution contract is:

```
k6 execution
    ↓
--summary-trend-stats="min,med,avg,max,p(50),p(95),p(99)"
    ↓
--summary-export=results.json
```

This `--summary-export` JSON is the canonical MVP result artifact. Every
`MetricsSummary` field maps directly from it — the engine must not compute
percentiles itself, only read what k6 already computed:

| MetricsSummary field | k6 summary source |
|---|---|
| `p50_ms` | `p(50)` (fall back to `med` if absent) |
| `p95_ms` | `p(95)` |
| `p99_ms` | `p(99)` |
| `average_ms` | `avg` |
| `max_ms` | `max` |
| `rps` | `http_reqs` rate |
| `total_requests` | `http_reqs` count |
| `error_rate` | `http_req_failed` value/rate |
| `failed_requests` | `error_rate * total_requests` |

Note k6's `--summary-export` layout has varied slightly across versions
(stats directly on the metric object vs. nested under a `values` key) —
handle both defensively (`app/services/k6_engine/metrics_parser.py` does).

**Raw NDJSON output (`k6 run --out json=raw.ndjson`) is NOT required for
MVP.** It is optional future/diagnostic tooling only. This is a deliberate
scope decision, not an oversight: boundary search is a sequence of
*independent* k6 invocations, one per experiment (e.g. 100 VUs → one run →
one summary; 500 VUs → a separate run → a separate summary; 1000 VUs →
another separate run → another separate summary). There is no multi-stage
ladder inside one invocation that would need steady-state windowing across
raw per-request records. Do not implement raw NDJSON parsing or windowing
for the current MVP.

## MetricsSummary fields (deterministic, never LLM-authored)

`p50_ms`, `p95_ms`, `p99_ms`, `average_ms`, `max_ms`, `rps`,
`total_requests`, `failed_requests`, `error_rate` (0..1), `duration_s`.
These are persisted end-to-end (`TestResultRecord` columns) and returned
verbatim by `GET /api/v1/runs/{id}/result` — no field is silently dropped
between the engine outcome and the API response. `p75_ms`/`p90_ms` and
`status_codes` (Session 5) join this list — see "Statistics / evidence
layer" below for their sourcing.

## Statistics / evidence layer (Session 5)

**The one rule this entire section exists to enforce: every statistic
either comes directly from a real k6 measurement, or is deterministically
derived from one by plain arithmetic. Nothing here is invented, estimated,
or LLM-produced.** `GET /api/v1/runs/{id}/result`'s new `statistics` field
(`app/schemas/test_result.py::Statistics`, built by `build_statistics()`)
is a derived, reorganized VIEW over the same, already-persisted
`MetricsSummary` — never a second source of truth, never persisted
separately, never computed by an LLM.

### Investigation: does k6's `--summary-export` already contain a
### per-status-code breakdown? (Answer: no — verified, not assumed)

Before writing any code, the project's own real captured k6 v2.2.0 output
was inspected: `tests/k6_engine/fixtures/real_pass_results.json`,
`real_fail_results.json`, and `demo-api/tools/k6_*_summary.json`. None
contain anything resembling a per-status count — `--summary-export`'s
`metrics` object is exclusively aggregate/tagged trend and counter
objects (`http_req_duration`, `http_reqs`, `http_req_failed`, `checks`,
`vus`, `iterations`, `data_sent`/`data_received`); `http_req_failed` is a
single binary rate (did the script's own `check()` condition consider
this a failure), not a status breakdown.

**What WAS found, unconditionally present in every fixture inspected**:
`root_group.checks`, keyed by whatever name a `check()` call in the
script used — present with no threshold declaration required (unlike the
per-endpoint tagged submetrics, which DO need the tautological-threshold
trick to appear in `--summary-export` at all).

**The mechanism chosen, verified empirically against the real, pinned k6
v2.2.0 binary before committing to it** (a throwaway script cycling
through six requests — three distinct real HTTP status codes returned by
`httpbin.org` — piped through `check(res, { ['http_status_' + res.status]:
() => true })`):

```
root_group.checks:
  http_status_200 -> {passes: 3, fails: 0}
  http_status_404 -> {passes: 2, fails: 0}
  http_status_500 -> {passes: 1, fails: 0}
```

Exact match to the real traffic sent (3× 200, 2× 404, 1× 500) — proving a
dynamically-named `check()`, computed from the ACTUAL observed
`res.status` at runtime, produces a status-level breakdown k6 already has
no other way to report, with **zero** new artifact format, **zero**
NDJSON, and **zero** change to the frozen `--summary-export` contract.
Because the check condition is always `() => true` (same tautological-
check discipline as the per-endpoint thresholds), this can never fail and
never affects k6's exit code. `res.status === 0` (k6's own convention for
"no response received") is recorded the same way — real evidence of a
failure mode, never a fabricated code.

Implementation: `app/services/k6_engine/script_renderer.py`'s
`recordHttpStatus()` (called after every real request this script makes,
including the checkout/cart special case) +
`app/services/k6_engine/metrics_parser.py`'s `_extract_status_codes()`
(reads ONLY `^http_status_(\d+)$`-matching check names — never confused
with this script's pre-existing, unrelated check names). **Only statuses
actually observed appear** — never a hardcoded list of plausible codes.

### p75 / p90 latency percentiles (Session 5, additive)

k6 already computes these as part of the same trend statistic it always
computed for `http_req_duration` — it just wasn't asked to *print* them.
`k6_runner.py`'s `--summary-trend-stats` was expanded from
`"min,med,avg,max,p(50),p(95),p(99)"` to
`"min,med,avg,max,p(50),p(75),p(90),p(95),p(99)"` — verified empirically
against the real k6 v2.2.0 binary to appear correctly and consistently
alongside the pre-existing percentiles, no other behavior change. Optional
on `MetricsSummary`/`Statistics` (`None` when absent, e.g. a `results.json`
predating this change) — **never backfilled or interpolated** from p50/
p95/p99.

### Canonical statistics schema

```
Statistics
├── latency        { p50_ms, p75_ms?, p90_ms?, p95_ms, p99_ms, average_ms, max_ms, tail_latency_ratio? }
├── throughput      { total_requests, requests_per_second, requests_per_minute }
├── errors          { failed_requests, error_rate, success_rate }
├── status_codes    { counts: {"200": N, ...}, percentages: {"200": X.X, ...} }
├── endpoint_rankings
│     { highest_p95_latency, highest_error_rate, highest_request_volume, highest_failed_requests }
│     -- each the FULL per_endpoint list sorted descending by that metric;
│        empty together when per_endpoint is empty (never a fabricated ranking)
└── endpoint_shares [ { endpoint, method, traffic_share, failure_share? } ]
```

| Field | Source | Formula |
|---|---|---|
| `latency.p50_ms`…`max_ms` | Direct from `MetricsSummary` (k6) | — |
| `latency.tail_latency_ratio` | Derived | `p99_ms / p50_ms`, `None` if `p50_ms == 0` |
| `throughput.requests_per_second` | Direct from `MetricsSummary.rps` (k6's own `http_reqs.rate`) | — |
| `throughput.requests_per_minute` | Derived | `requests_per_second * 60` — **deliberately NOT** `total_requests / wall_clock_duration_s * 60`; see below |
| `errors.success_rate` | Derived | `1 - error_rate` |
| `status_codes.percentages` | Derived | `count / total_requests * 100`, omitted entirely if `total_requests == 0` |
| `endpoint_rankings.*` | Derived | `MetricsSummary.per_endpoint` sorted descending by the named metric |
| `endpoint_shares[].traffic_share` | Derived | `endpoint.total_requests / total_requests` |
| `endpoint_shares[].failure_share` | Derived | `endpoint.failed_requests / failed_requests`, `None` if `failed_requests == 0` |

**Why `requests_per_minute` uses `rps * 60`, not a fresh division**:
`MetricsSummary.duration_s` is the ENGINE's own wall-clock measurement
around the whole k6 subprocess call (`engine.py`'s `time.monotonic()`),
which includes k6 process startup/teardown — NOT the pure in-test traffic
window. Dividing `total_requests` by that duration would UNDERSTATE real
throughput. `rps` (k6's own `http_reqs.rate`) already excludes that
overhead — it's k6's own internal per-second rate during actual traffic —
so it is the only semantically correct basis for a per-minute derivation.

### What was deliberately NOT built

- **No arbitrary "performance score"/"health score"/quality index** — every
  field above traces to a named, documented formula; nothing here
  synthesizes an opinion.
- **No per-endpoint status-code breakdown** — `recordHttpStatus()` records
  globally, not per-endpoint-tag. The audited list of needed endpoint
  statistics (`docs/performance_engine_interface.md`'s "Rich experiment
  representation" section) didn't ask for it, and adding it would double
  the number of dynamically-named checks for no demonstrated need yet —
  a natural, obvious extension of the SAME mechanism if ever needed.
- **No true streaming/NDJSON status collection** — stays inside the frozen
  `--summary-export` contract, deliberately.
- **No estimated p75/p90 fallback** — absent means absent.

## Terminal presentation (Session 6)

Reads the Session 5 `Statistics`/`TestResult` objects and formats them for
a human running a live demo — it computes nothing. `app/presentation/
terminal_report.py` (pure functions, no I/O) + `scripts/run_demo.py` (the
thin CLI glue: POST/GET against the EXISTING, unmodified
`/api/v1/runs*` routes, then hands the parsed response straight to the
formatter).

**Source of truth**: exclusively `Statistics` (Session 5) and the rest of
`TestResult`/`RunStatusResponse` — never a second parse of `results.json`,
never a recomputed percentile/rate/ranking. Endpoint rows are ordered
using `Statistics.endpoint_rankings.highest_p95_latency` verbatim (the
same canonical ranking Session 5 already computed), not a new sort.

**What's displayed**: target, test type, workload (VUs, duration or
ramp+hold, endpoints, weights), run state; on `COMPLETED` — latency
(p50/p75/p90/p95/p99/avg/max + tail-latency ratio), throughput
(requests, req/s, req/min), errors (failed, error rate, success rate),
HTTP status-code counts+percentages (whatever codes were actually
observed — never a fixed/hardcoded set), an endpoint table, threshold
PASS/FAIL (+ readable violations when they exist), and artifact paths.

**Unit-safety (the one bug this session was explicitly warned about)**:
`error_rate`/`success_rate` are fractions (0..1) → rendered `× 100`;
`Statistics.status_codes.percentages` is ALREADY on a 0..100 scale →
rendered as-is, never multiplied again. Both paths have dedicated tests
(`tests/test_terminal_report.py`).

**Missing evidence**: `p75_ms`/`p90_ms` absent → `N/A`; no per-endpoint
data → `"No endpoint evidence available"`; no status-code data →
`"No status-code evidence available"`; `tail_latency_ratio` omitted
entirely when undefined (`p50_ms == 0`). A `TestResult` with
`statistics=None` (e.g. an older hand-built object) falls back to the
raw aggregate `threshold_status`, never a crash.

**Failure display**: `EXECUTION_ERROR` prints the same already-stored,
concise `error_message` `GET /runs/{id}` already returns — no raw stack
trace, no new error-formatting logic; the full exception detail remains
in the project's existing logs, unmodified.

**Secret safety**: structural, not just tested — neither `TestResult` nor
`RunStatusResponse` has any auth-shaped field at all (see
`docs/target_auth_contract.md`), so there is nothing for this layer to
leak. `tests/test_terminal_report.py` documents this guarantee explicitly
rather than relying on it silently.

**API/schema**: zero changes. No new field, no renamed field, no route
added — `scripts/run_demo.py` only calls the three routes that already
existed before this session.

**Demo commands** (Windows PowerShell):

```powershell
# Terminal 1 — demo API
cd demo-api
python run.py

# Terminal 2 — backend
cd backend
$env:K6_BINARY = "C:\Program Files\k6\k6.exe"
python -m uvicorn app.main:app --reload

# Terminal 3 — run the demo CLI
cd backend
python scripts/run_demo.py --plan-id baseline_checkout --target http://127.0.0.1:8080
```

## Workload safety limits (enforced before execution, not by k6)

`app/services/workload_limits.py` enforces `MAX_VUS` and `MAX_DURATION_S`
(env-configurable, see `app/core/config.py`) against every `TestPlan`
before it is persisted or reaches the engine — for `boundary_search`,
`ramp_duration + hold_duration` counts as the plan's total duration; for
`fixed_load`, `duration` does. This is separate from
`K6_EXECUTION_TIMEOUT_S`, which is a wall-clock ceiling on the k6
*process* (protects against a hung run), not a workload-size limit. The
engine can assume any plan it receives has already passed this gate — it
does not need to re-validate VU counts or durations itself.

**Policy: reject, never silently adjust (unchanged, Session 3 reviewed
this explicitly and kept it).** An intent-originated plan that exceeds
`MAX_VUS`/`MAX_DURATION_S` still compiles to `INVALID` /
`workload_limit_exceeded` — Session 3 considered auto-capping to the
configured envelope instead, but rejected it: the existing, tested,
documented contract ("no separate, weaker limit for intent-originated
plans", `docs/ai_intent_architecture.md` §11) treats an intent exactly
like a hand-authored `TestPlan` submitted directly to `POST /api/v1/runs`
— and a directly-submitted `TestPlan` is a precise technical request that
must fail loud if invalid, never be silently rewritten. What Session 3
DID add, purely additively: `app/services/intent_compiler.py`'s
`WORKLOAD_LIMIT_EXCEEDED` rejection message is now enriched with a
concrete "Requested: X / Safe configured maximum: Y" suggestion (computed
from the SAME `MAX_VUS`/`MAX_DURATION_S`, never a separate value) — purely
advisory text in `rejection_reason`, never a second `TestPlan`, never
auto-applied. The configured envelope itself is also now readable
up-front via `GET /api/v1/intents/workload-limits` (`{max_vus,
max_duration_s}`, read-only, additive) so a caller doesn't need to guess-
and-check against a rejection to discover it.

## Payload generation safety bounds (Session 3, additive)

`app/services/k6_engine/payload_generator.py` — since Session 1 opened
OpenAPI *discovery* to an arbitrary user-supplied URL, a request-body
schema is no longer necessarily authored by this project's own team.
Three independent, env-configurable bounds (`app/core/config.py`) protect
against a pathological or adversarial schema without changing output for
any real-world schema this project has ever exercised:

| Bound | Default | Protects against |
|---|---|---|
| `MAX_PAYLOAD_DEPTH` | 12 | Deeply/pathologically nested inline objects or arrays (no `$ref` needed) exhausting the Python call stack |
| `MAX_PAYLOAD_ARRAY_ITEMS` | 20 | A schema's own `minItems`/`maxItems` driving an enormous generated array |
| `MAX_PAYLOAD_BODY_BYTES` | 64 KiB | The fully-generated body's serialized size, checked once at `generate_request_body()`'s top level (a wide-but-shallow schema — many simple fields — could exceed this even though no single field is individually oversized) |

All three raise the existing `UnsupportedSchemaError` (fail loud, never a
truncated/best-guess body) when exceeded. A parallel bound,
`MAX_REF_RESOLUTION_DEPTH` (default 20), guards
`app/services/k6_engine/openapi_loader.py`'s nested-`$ref` resolution pass
(see below) the same way.

## Nested `$ref` resolution (Session 3 — closes a previously-documented gap)

`docs/target_api_notes.md` §6 documented a proven, then-unresolved gap: a
`$ref` nested inside a request-body schema (e.g. an array's `items`
pointing at another component schema — the standard shape FastAPI/Pydantic
emits for `List[SomeModel]`) was resolved only at the schema's own top
level, and reached `payload_generator.py` unresolved
("no generation rule for schema type: None"). `openapi_loader.py`'s
`_deref_tree()` now walks the full schema tree (`properties`/`items`,
nested arbitrarily) and resolves every `$ref` it finds — cycle-safe (a
legitimate recursive-type shape, e.g. a tree schema, is left unresolved
past the first cycle rather than expanded forever) and depth-bounded
(`MAX_REF_RESOLUTION_DEPTH`) against a very long but acyclic chain.
`payload_generator.py` needed zero changes — it already assumed a fully-
dereferenced tree, which is exactly what it now always receives.

## Payload strategy (Session 3, additive)

`TestPlan.payload_strategy` (`app/schemas/enums.py::PayloadStrategy`,
defaults to `normal`) selects between exactly two fixed, deterministic
request-body generation rules in `payload_generator.py` — never a fuzzing
framework, never randomness:

- `normal` — unchanged pre-existing behavior.
- `boundary` — pushes each generated value to the nearest schema-declared
  edge (`maximum`/`minimum`/`exclusiveMaximum`/`exclusiveMinimum` for
  numbers, `maxLength`/`minLength` for strings, `maxItems`/`minItems` for
  arrays — capped at `MAX_PAYLOAD_ARRAY_ITEMS` regardless — or the LAST
  `enum` value instead of the first), falling back to the exact `normal`
  value for any field with no such edge declared. An explicit
  `example`/`default` on the schema always wins over either strategy.

Threaded straight through `script_renderer.py` to every
`generate_request_body()` call it makes (including the `/checkout`↔`/cart`
special case) — the renderer never decides which values are generated, it
only passes the plan's own choice along. Verified against real k6
execution (`tests/k6_engine/test_payload_strategy_execution.py`): the
actual request body bytes a real target receives change with the
strategy, not just the generated script text.

## Wiring

**Status: complete.** `app/services/engine_provider.py` points at
`RealK6PerformanceEngine` (`app/services/k6_engine/engine.py`).
`reference_k6_engine.py` has been deleted — it was a temporary Phase-1
placeholder, never a second production-selectable engine architecture.
Full backend test suite (77 tests) and the real k6 integration suite
against the canonical demo API both pass against the real engine.

## Target environments

MVP targets are **local / staging / sandbox only**. Production load
testing is explicitly out of scope for the current phase — there is no
target-authorization workflow, rate limiting, or safety review for hitting
a real production service, and none should be assumed.

## Rich experiment representation (Session 4 audit)

Audited whether `TestPlan` already carries enough structured information
for `render_script()` to execute a user's intent faithfully, before adding
anything. Every field below was traced to its actual, current consumer —
not assumed from an earlier design doc.

| Experiment dimension | Status | Where |
|---|---|---|
| Objective (`objective_type`: boundary_search/fixed_load) | IMPLEMENTED | Drives `_stages_js()`'s ramp+hold vs. single-stage branch — the one objective field that actually changes rendered output |
| `test_type` (baseline/soak/stress) | IMPLEMENTED as a label, honestly NOT differentiated at execution | Persisted, returned in results; never read by `script_renderer.py`, `threshold_evaluator.py`, or `metrics_parser.py` (confirmed by inspection: zero references) — soak and baseline render byte-identical scripts, exactly as `ai_intent_architecture.md` §6 already documents ("honestly represented, not invented") |
| Target VUs | IMPLEMENTED | `plan.target_vus` → every k6 stage's `target` |
| Duration / ramp / hold | IMPLEMENTED | `plan.duration` or `ramp_duration`+`hold_duration` → `_stages_js()` |
| Endpoint selection | IMPLEMENTED | `selected_endpoints` → `endpoint_resolver.resolve_selected_endpoints()` |
| Endpoint weights (traffic distribution) | IMPLEMENTED | `endpoint_weights` → `_endpoint_weights()`/`_weighted_dispatch_js()`; uniform when unset |
| Endpoint tags (per-endpoint evidence) | IMPLEMENTED | `build_endpoint_tags()` → `endpoint_<i>` aliases → tautological thresholds → `metrics_parser.py`'s per-tag lookup |
| Thresholds | IMPLEMENTED, Python-side only | `plan.thresholds` → `threshold_evaluator.evaluate_threshold()`, computed AFTER k6 exits from parsed metrics — never a k6-native threshold (k6's own emitted thresholds are deliberately tautological, see the endpoint-tagging note above; a k6-native threshold crossing would instead be an EXECUTION_ERROR, not this PASS/FAIL) |
| Payload strategy | IMPLEMENTED (Session 3) | `plan.payload_strategy` → every `generate_request_body()` call in `script_renderer.py` |
| Authentication / runtime configuration | IMPLEMENTED (Session 2.5) | `target.auth` → k6 subprocess `__ENV`, never `script.js` literally |
| Request sequence / journey | PARTIALLY IMPLEMENTED (see below) | One hardcoded `/checkout`→`/cart` special case only; no general mechanism |
| Assumptions/adjustments | IMPLEMENTED | `plan.assumptions`, populated by `intent_compiler.py` |

**Conclusion: `TestPlan` is already sufficient.** No new field was added
this session — every dimension the brief asked about already has a real,
traced consumer, except request sequences (addressed below) and `test_type`
differentiation (an existing, already-documented, deliberate limitation,
not a gap this session should paper over by inventing soak-specific
execution behavior that doesn't exist).

### Request sequences: considered, not implemented this session

The existing `/checkout`→`/cart` dependency
(`script_renderer._render_checkout_with_cart_dependency`) is a single
hardcoded special case, not a general mechanism — inspected closely before
deciding whether to generalize it into an explicit `TestPlan` sequence
field (e.g. `request_sequence: Optional[List[str]]`).

**Why generalizing it was judged too risky for this session, not just
inconvenient:**

1. **It requires a real dispatch-model fork, not an additive branch.**
   Today, exactly one endpoint is chosen per VU iteration (a single
   `Math.random()` draw, weighted or uniform). A sequence, by definition,
   must execute *multiple* endpoints in order within one iteration —
   structurally different from, not an extension of,
   `_weighted_dispatch_js()`. That fork touches the most heavily-tested
   file in the system (`script_renderer.py`, ~4 dedicated test files).
2. **Without data-threading between steps, a plain ordered sequence adds
   limited value beyond what already exists** (multiple `selected_endpoints`
   already lets a plan exercise several endpoints); the one case where
   ordering AND data-threading both matter (browse → add-to-cart →
   checkout, where `cart_id` must flow from step 2 into step 3) is
   *exactly* the existing hardcoded special case — and the brief
   explicitly forbids building general dependency inference to solve the
   threading problem for arbitrary future sequences.
3. **The existing special case already covers the one sequence that
   matters for this project's canonical target.** There is no second,
   currently-demonstrable need driving a generalization (the brief's own
   "only add a field when there is a concrete execution need" standard).

**Recommendation for a future session, if this becomes a real need**: add
`request_sequence` as a **strictly separate, new** rendering path —
activated only when explicitly set, never touching
`_weighted_dispatch_js()` or the existing checkout/cart special case —
supporting ordered, NO-data-threading execution only (call step 1, then
step 2, then step 3, each independently payload-generated); explicitly
scope out response-to-next-request threading as a distinct, separately-
reviewed follow-on (the checkout/cart case remains the one exception,
unchanged).

### Endpoint mix (Part C) — verified, not changed

- Default (no `endpoint_weights`) remains uniform — confirmed unchanged,
  `tests/k6_engine/test_script_renderer.py::test_uniform_dispatch_when_no_weights_given`.
- Explicit weights are validated once, authoritatively, by `TestPlan`'s own
  model validator (unchanged).
- Generated k6 correctly reflects the configured distribution — reconfirmed
  with a REAL k6 run combining weights with auth and payload strategy at
  once (`tests/k6_engine/test_rich_experiment_execution.py`), not just the
  existing static string-match tests.
- A frontend can already display the chosen traffic mix without any new
  field: `GET /runs/{id}/result`'s `plan.endpoint_weights` (and
  `plan.selected_endpoints` for the implied uniform case) is already
  returned verbatim — see "Experiment metadata" below.

### Experiment metadata (Part H) — already satisfied, nothing added

`GET /api/v1/runs/{id}/result`'s `TestResult.plan` (populated by
`routes_runs.py`, unchanged) already carries the complete `TestPlan` —
objective, VUs, duration, endpoint mix, payload strategy, thresholds,
assumptions — verbatim. This already IS "what experiment was actually run"
metadata; duplicating it into a second, parallel summary structure would
violate the brief's own "do not duplicate the entire TestPlan
unnecessarily" instruction. Nothing new was added here.

### Authentication (Part F) — regression-checked, not touched

`script_renderer.py`'s `AUTH_HEADERS`/`__ENV` mechanism (Session 2.5) is
unmodified by Session 3 or 4. Full `tests/k6_engine/test_auth_propagation_execution.py`
and `test_script_renderer_auth_headers.py` suites still pass unmodified,
and the new rich-experiment test above additionally proves auth continues
to reach every request when composed with weights and payload strategy.

### K6 script quality (Part G) — reviewed, no changes made

Inspected the current generated script structure for readability/
determinism/injection-safety. No change made: the existing structure
(named `const` declarations, `Object.assign`-based header merging, one
comment block per non-obvious mechanism) already meets the bar, and
`test_script_renderer_injection.py`'s real-Node execution tests continue
to pass unmodified — introducing a new abstraction here without a
demonstrated readability problem would be exactly the unnecessary
complexity the brief warns against.

## Failure localization (final session)

`app/schemas/test_result.py::FailureLocalization` / `build_failure_localization()`
— answers WHAT failed, WHERE, UNDER WHAT LOAD, WHICH threshold, and WHAT
EVIDENCE supports it, using ONLY data that already exists
(`threshold_violations`, `MetricsSummary`, `TestPlan`). Computes no new
statistic — a pure, deterministic reorganization, attached additively to
`GET /runs/{id}/result` (assembled fresh, same pattern as `statistics`,
never persisted separately).

- `overall_status` mirrors `threshold_status` verbatim — never recomputed.
- `violations` is `threshold_violations` verbatim — authoritative.
- `primary_failure`: deterministic selection among possibly-multiple
  violations, ranked in order: **(1) metric type first** — `error_rate`
  always outranks `p95_latency_ms` (`_METRIC_SEVERITY_RANK`; a request
  that failed outright is a more severe failure mode than one that merely
  completed slowly, a simple, one-sentence-explainable, stable priority)
  — **(2) within the same metric type**, relative overage (`observed /
  threshold`, division-by-zero guarded) highest first — ratios ARE
  meaningful once the unit is identical, unlike across different metric
  types — **(3)** a specific endpoint scope over "overall", **(4)**
  alphabetically. Deliberately NOT a raw cross-metric-type ratio
  comparison (an earlier version of this rule was exactly that, and was
  revised: a 1.1x latency overage and a 1.1x error-rate overage are not
  defensibly "equally bad", so no attempt is made to rank across metric
  types by ratio). Can be non-null even when `overall_status == PASS` (a
  real, documented edge case: a single endpoint can violate its own
  threshold while the aggregate still passes — surfaced, never
  suppressed).
- `evidence`: the real measured numbers for the primary failure's scope
  (aggregate `MetricsSummary` fields, or the matching `EndpointMetrics`
  entry) — nothing fabricated when a field wasn't collected.
- `load_context`: read straight off the persisted `TestPlan`.
- **Explicitly NOT root-cause detection** — never an infrastructure claim
  (e.g. "database locking"). Says WHERE and WHICH threshold, never WHY.

## AI result analyzer (final session)

`app/services/ai_analyzer.py::AIResultAnalyzer` — mirrors
`llm_intent_interpreter.py`'s exact architecture (Protocol + OpenAI-
compatible implementation, plain httpx, same `LLM_API_KEY`/`LLM_MODEL`/
`LLM_BASE_URL`/`LLM_TIMEOUT_S` config — one provider configuration for
this project, not a second one) and the same "never trust the raw
provider response" pipeline: JSON extraction → `json.loads` → 
`AIAnalysis.model_validate()` — any failure at any step returns `None`,
never raises, never a best-effort guess.

**Separate, explicit endpoint — `POST /runs/{id}/analyze`** — deliberately
NOT computed as a side effect of `GET /runs/{id}/result`. This mirrors the
existing `POST /intents/interpret` vs. `/compile` boundary already
established in this codebase: an LLM step is always a distinct, human-
triggered call, never silently invoked on a fast, deterministic read path.

**The contract is deliberately explicit-only, not half-persisted**:
`TestResult` (returned by `GET .../result`) carries NO `ai_analysis` field
at all — an earlier revision of this session added one (always `None`,
since nothing ever wrote to it), which is exactly the kind of misleading
"looks like data that might show up later, never does" design this was
revised away from. `AIAnalysis` is returned ONLY by `POST .../analyze`'s
own `AIAnalysisResponse{available, analysis, reason}`. `GET .../result`
stays fast, deterministic, and side-effect-free; a client that wants AI
analysis calls `/analyze` explicitly and renders its own response,
independent of the result fetch.

**Grounding (input)**: `AIAnalysisInput` bundles `plan` (`TestPlan` — no
auth field exists on it at all), `target_base_url` (a plain URL string,
never secret), `threshold_status`, `statistics`, and `failure_localization`
— every field already exists elsewhere; the model computes no metric
itself. Structurally incapable of carrying a secret, not just
by convention.

**Failure handling (all verified against a real, unconfigured environment
— no `LLM_API_KEY` set — not just mocked)**:

| Case | Behavior |
|---|---|
| LLM unreachable / non-2xx / timeout | `analyze()` returns `None`; route returns `200 {available: false, reason: "..."}` — never a 500, never affects the run's own state |
| Malformed JSON | `None` — same path |
| Schema-invalid JSON (e.g. `"severity": "catastrophic"`) | `None` — rejected by `AIAnalysis.model_validate()`, never a partial/best-effort object |
| Success | `200 {available: true, analysis: {...}}` |

The deterministic result (`metrics`, `statistics`, `failure_localization`,
`threshold_status`) is complete and correct in every case above — AI is
optional interpretation, never the source of truth.

## Frontend/backend contract (final session)

`clone/performance-evaluator-frontend` (React + Vite + TypeScript) was
audited field-by-field against the real backend schemas before any change
— found genuinely stale: `TargetConfig` (missing `openapi_url`/`auth`,
Sessions 1/2/2.5), `TestPlan` (missing `payload_strategy`, Session 3),
`MetricsSummary`/`TestResult` (missing the entire Session 5 `statistics`
field and everything from this final session). All API routes the
frontend calls were verified against the real FastAPI routes — no
invented endpoint, no route mismatch found. The pre-existing client-side
`buildInsight()` heuristic in `ResultsPanel.tsx` was kept (still useful,
low-cost, doesn't overlap with the new structured sections). Changes made
were purely additive: extended TypeScript types, a new minimal
auth-input section in `ApprovalGate.tsx` (bearer/API-key-header, wired
through to `POST /runs`), and new `ResultsPanel.tsx` sections for latency
detail, status codes, failure localization, and an explicit "Get AI
analysis" button calling `POST /runs/{id}/analyze` — never auto-triggered.
No UI redesign, no new architecture, no invented backend behavior.

## Known, current limitations (final session)

- AI analysis requires `LLM_API_KEY` to be configured; without it, every
  `/analyze` call returns `available: false` (verified, not assumed).
- Failure localization's `primary_failure` selection is a documented,
  fixed heuristic (relative overage, then scope specificity) — not
  configurable, and deliberately not root-cause detection.
- Per-endpoint HTTP status-code evidence still does not exist (Session 5's
  scope decision, unchanged) — `FailureEvidence.status_codes` is therefore
  always empty for an endpoint-scoped failure.
- The frontend's auth input is intentionally minimal (bearer/API-key-header
  only, matching the backend's own supported set) — no OpenAPI-URL input
  field was added to the UI (not required by any current product flow;
  the backend capability exists and is exercised via `POST /runs`'s
  existing `target` object either way).
