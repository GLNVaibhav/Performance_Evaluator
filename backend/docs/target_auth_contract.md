# Target OpenAPI URL + Authentication Contract

**Status: implemented (Session 1 + Session 2 + Session 2.5), additive, zero
execution-core redesign.** Extends the existing `TargetConfig`
(`app/schemas/test_plan.py`) rather than introducing a competing
target/auth model — `TargetConfig` already appeared exactly once in the
whole system, at the one place a `TestPlan` and a real target first meet
(`RunCreateRequest.target`, `app/schemas/run.py`), and its own pre-existing
docstring already flagged auth as "deliberately out of scope for Phase 1"
— i.e. this was the anticipated extension point, not a new one invented
for this work.

**Session 2.5 closed the one gap Sessions 1+2 left explicit and documented**
(§5, old revision): `TargetConfig.auth` authenticated the backend's own
OpenAPI-*discovery* fetch, but not k6's real target traffic. That traffic
is now authenticated too — see §5 below (superseding the old §5) for the
mechanism and §11 for what is verified.

## 1. The contract

```
TargetConfig
  base_url:     str                 (required, unchanged)
  openapi_url:  Optional[str]       (NEW -- Session 1)
  auth:         Optional[AuthConfig] (NEW -- Session 1)

AuthConfig (app/schemas/auth.py)
  type:        "none" | "bearer" | "api_key_header"
  token:       SecretStr, required iff type == "bearer"
  header_name: str,       required iff type == "api_key_header"
  api_key:     SecretStr, required iff type == "api_key_header"
```

`UniversalPerformanceIntent` (`app/schemas/intent.py`) is **not** touched
and gains no target/auth concept — confirmed unchanged, matching the
existing, explicit design principle that the intent layer has no target
notion at all (`docs/workflow_contract.md` §7: "the target is never chosen
by the compiler or the intent"). Natural-language intent, target
configuration, and authentication remain three separate inputs that meet
for the first time at `POST /api/v1/runs`, exactly as before.

## 2. Why only two auth types

`bearer` and `api_key_header` are the only two mechanisms with an actual
consumer (`app/services/auth_headers.py::build_auth_headers()`). Basic
auth, OAuth2 flows, mTLS, cookie-based auth, etc. are not implemented —
adding the enum member without a real code path to use it would be exactly
the kind of unused surface this project avoids elsewhere (compare
`app/schemas/intent.py::BusinessFlow`, structurally present but always
rejected until a real consumer exists). An unrecognized `type` value is a
`422` at the Pydantic boundary (closed enum) — never silently ignored.

## 3. Secret isolation — the data-flow diagram, as actually implemented

```
User supplies base_url / openapi_url / AuthConfig (raw secret)
        |
        v
TargetConfig                                    <- app/schemas/test_plan.py
  (real secret lives here, as pydantic SecretStr)
        |
        +----------------------------+-----------------------------------+
        |                            |                                   |
        v                            v                                   v
sanitize_auth(target.auth)  build_auth_headers(target.auth)   build_auth_env(target.auth)
  -> SanitizedAuthMetadata    -> {"Authorization": "Bearer <real>"}  -> {"PERF_EVAL_AUTH_HEADER_NAME": ...,
     {auth_available,            or {<header_name>: <real>}            "PERF_EVAL_AUTH_HEADER_VALUE": <real>}
      auth_type}                       |                                   |
        |                              v                                   v
        v                    app/services/k6_engine/openapi_loader.py   subprocess env of the k6
POST /api/v1/targets/discover  ::load_normalized()'s httpx.get() call   PROCESS ONLY (app/services/
  response (LLM-safe; a         (the backend's OWN OpenAPI-discovery     k6_engine/k6_runner.py's
  future planning/               fetch -- NOT k6's own requests)         `env` param) -- read back by
  interpretation layer                                                   the generated script via
  consumes ONLY this)                                                    k6's __ENV, NEVER written
                                                                          into script.js itself
```

**The raw secret is unmasked in exactly two functions in the whole
codebase**, both in `app/services/auth_headers.py`:
`build_auth_headers()` (OpenAPI-discovery fetch — called from
`app/services/target_validation.py::validate_target_compatibility()` and
`app/services/k6_engine/engine.py::RealK6PerformanceEngine.execute()`
before its `load_normalized()` call) and, new in Session 2.5,
`build_auth_env()` (real k6 target traffic — called from that same
`execute()` immediately before its `run_k6()` call, and *only* to build an
environment-variable dict for the subprocess call, never to build a
string that becomes part of `script.js`, a log line, or any persisted
value). Neither `app/services/llm_intent_interpreter.py` nor
`app/services/intent_compiler.py` imports `auth_headers.py`, `AuthConfig`,
or anything under this contract — confirmed by those files' own import
lists (unchanged by this work).

### Where a secret CANNOT appear (verified, not merely intended)

| Surface | Guarantee | How verified |
|---|---|---|
| `UniversalPerformanceIntent` / LLM prompt | No field exists to hold it — intent schema is untouched | Inspection; no import of `app/schemas/auth.py` anywhere under `intent.py`/`llm_intent_interpreter.py` |
| `POST /api/v1/targets/discover` response | Response model (`TargetDiscoveryResponse`) carries only `SanitizedAuthMetadata`, never `AuthConfig` | `tests/test_target_discovery_route.py::test_discovery_reports_sanitized_auth_metadata_without_the_secret` |
| `GET /runs/{id}/result`, `GET /runs/{id}` | `TestResult`/`RunStatusResponse` have no auth-shaped field at all (unmodified) | `tests/test_target_auth_execution.py::test_run_with_bearer_auth_completes_and_leaks_the_secret_nowhere` — checked against a REAL completed run |
| Generated `script.js` | Contains only the two FIXED, non-secret env-var *names* (`PERF_EVAL_AUTH_HEADER_NAME`/`_VALUE`) — the real value exists solely as the k6 subprocess's own environment variable, never interpolated into the source (Session 2.5) | `tests/k6_engine/test_auth_propagation_execution.py::test_secret_never_appears_in_script_or_result_artifacts` — reads the real generated file from a real completed run |
| `stdout.log` / `stderr.log` / `results.json` | k6 never echoes its own environment variables into these outputs (nothing in the generated script prints `__ENV`, and neither does k6 itself) | Same test |
| The database (`TestRunRecord`/`TestPlanRecord`/`TestResultRecord`) | `auth`/`openapi_url` are never written to any column — only `target_base_url` (a plain string, unchanged) is persisted | Inspection of `app/storage/repository.py` (untouched) + `app/services/run_service.py`'s new `target_context_store` usage, which is explicitly in-memory only |
| Repr / `str()` / default JSON serialization of `AuthConfig` itself | `SecretStr` masks to `**********` | `tests/test_target_auth_schema.py::test_secret_str_is_masked_in_repr_and_str`, `..._in_default_json_serialization` |
| Error messages from a failed OpenAPI fetch / engine exception | Defensively scrubbed even though the underlying exceptions don't echo header values in practice | `app/services/secret_redaction.py`, wired into `engine.py` and `run_service.py`'s exception handlers |

## 4. The execution-boundary gap this had to solve, and how

`execute_run()` is a FastAPI `BackgroundTask` that reopens its own DB
session and previously reconstructed `TargetConfig(base_url=...)` from
`TestRunRecord.target_base_url` alone. Since `auth`/`openapi_url` are
deliberately never persisted (see the table above), naively doing nothing
else would mean a run's OpenAPI-discovery re-fetch during background
execution loses the credential and any explicit `openapi_url` override
between `create_run()` and `execute_run()` — a real correctness gap, not
just a security one.

**Solution: `app/services/target_context_store.py`**, a small in-memory,
per-run dict (`run_id -> {openapi_url, auth}`), populated by `create_run()`
right after the run's id is minted, read back by `execute_run()` to
reconstruct the full `TargetConfig`, and discarded in `execute_run()`'s
`finally` block once the run reaches a terminal state.

**Explicit, accepted limitation**: this is single-process, in-memory
state. It does not survive a process restart between run creation and
execution, and has no place in a future multi-process/distributed
task-queue deployment — that would need a real short-TTL, encrypted-at-rest
secret store. Acceptable today because `create_run()` and `execute_run()`
already run in the same process (the existing, unmodified background-task
model this backend has always used) — this is not a new assumption, just
one now load-bearing for a second reason.

## 5. k6-script credential injection (Session 2.5 — implemented)

The generated k6 script's own HTTP requests (`script_renderer.py`) now
**do** receive the configured auth header, for every currently-supported
HTTP method (GET and every POST/PUT/PATCH/DELETE `script_renderer.py`
generates), including the auto-generated `/cart` call inside the
`/checkout` dependency special-case.

**Mechanism: k6's own `__ENV` runtime-environment-variable feature, not
literal interpolation.** The generated script contains only two FIXED,
NON-SECRET env-var *names*:

```js
const AUTH_HEADER_NAME = __ENV.PERF_EVAL_AUTH_HEADER_NAME || '';
const AUTH_HEADER_VALUE = __ENV.PERF_EVAL_AUTH_HEADER_VALUE || '';
const AUTH_HEADERS = AUTH_HEADER_NAME ? { [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE } : {};
```

The real secret is never written into `script.js`. It exists only as an
environment variable on the k6 **subprocess** itself
(`app/services/k6_engine/k6_runner.py::run_k6()`'s new `env` parameter,
`subprocess.run(..., env={**os.environ, **env})`), set by
`app/services/k6_engine/engine.py` from
`app/services/auth_headers.py::build_auth_env(target.auth)` immediately
before that one subprocess call. k6 exposes process environment variables
to the script via `__ENV` — this is k6's own, standard, documented
mechanism for exactly this purpose (verified empirically against the
pinned **k6 v2.2.0** binary this project uses — `k6 version` on the
development machine: `k6.exe v2.2.0 (commit/00a9a1b7f5, go1.26.5,
windows/amd64)` — see `tests/k6_engine/test_auth_propagation_execution.py`
for the real subprocess proof, not just a claim).

**One generic mechanism for both supported auth types.** `bearer` and
`api_key_header` both resolve to exactly one (header name, header value)
pair via the pre-existing `build_auth_headers()` (Session 1/2) — `("Authorization",
"Bearer <token>")` or `(<header_name>, <api_key>)` respectively — so
`script_renderer.py` never needs to know which auth type was configured;
it only ever reads one generic name/value pair.

**Every request's headers are merged the same way**, reusing the exact
`Object.assign({}, <base>, {...})` idiom this file already used for the
checkout-body merge (not a new merging idiom): `headers:
Object.assign({}, AUTH_HEADERS, <whatever headers this request already
needed>)`. When no auth is configured, `AUTH_HEADERS` evaluates to `{}` at
runtime — byte-for-byte the same "no extra headers" behavior as before
this amendment; the *generated source* gained this one constant clause
for every request (including a previously-bare, untagged `GET`, which now
always carries a `{ headers: ... }` params object), but the *actual header
set k6 sends* is unchanged for every existing no-auth caller.

**What was deliberately NOT changed**: `script_renderer.py`'s injection-
safety discipline (`_js_url_expr()`'s `json.dumps`-encoded string
literals, never string concatenation into a template literal) is
untouched and unaffected — `AUTH_HEADERS` never carries externally-derived
*text* through a code path that constructs JS syntax from it; it is a
plain object built from two env-var reads, structurally incapable of the
class of injection `_js_url_expr` defends against. The full existing
`tests/k6_engine/test_script_renderer_injection.py` suite (39 tests,
including real Node syntax-validity and behavioral-execution checks)
passes unmodified against the changed renderer.

## 6. OpenAPI URL vs. base URL — no silent host substitution

`openapi_url` and `base_url` are **independent, both explicit** — the
system never infers one from the other and never redirects a user's real
traffic to a different host than they specified:

- Omit `openapi_url` → unchanged, pre-existing behavior: the spec is
  fetched from `{base_url}/openapi.json`.
- Supply `openapi_url` → the document is fetched from exactly that URL
  (no `/openapi.json` suffix appended) — real test traffic (rendered into
  `script.js` as `BASE_URL`) still only ever uses `base_url`, unchanged.

This directly answers the Session 2 brief's "verify the OpenAPI URL and
actual base URL cannot accidentally become inconsistent in a dangerous
way": they are never made *consistent* with each other at all — each is
used only for its own single, fixed purpose.

## 7. SSRF policy (`app/services/target_url_safety.py`)

Hackathon-grade, not enterprise SSRF protection — see that module's own
docstring for the full list of accepted gaps (no redirect re-checking
beyond the existing "non-200 is rejected" behavior, no DNS-rebinding
protection, no IPv6-mapped-IPv4 edge-case handling).

**The one policy decision that matters for this specific project**: this
system's own canonical demo API and its entire existing test suite target
`127.0.0.1` — a naive "block all private/loopback" default would break the
project's own primary supported use case (documented repeatedly as
"local/staging/sandbox only" in `docs/performance_engine_interface.md`).
So:

- **Always blocked, regardless of policy**: link-local addresses
  (`169.254.0.0/16`, including the common `169.254.169.254` cloud-metadata
  IP used by AWS/Azure/GCP) and Alibaba Cloud's `100.100.100.200` metadata
  IP, plus IPv6 link-local (`fe80::/10`). No legitimate performance-test
  target exists in this range.
- **Allowed by default** (`TARGET_SSRF_POLICY=allow_private`, the
  default): loopback (`127.0.0.0/8`, `::1`) and RFC1918 private ranges
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`).
- **`TARGET_SSRF_POLICY=block_private`** (opt-in, env-configurable):
  additionally blocks loopback/private, for a deployment where the backend
  itself is reachable from outside and that tradeoff is wanted.

Deliberate asymmetry, matching the existing `target_validation.py`
pattern exactly: a hostname that fails to resolve at all does **not**
raise — "can't verify" is never treated as "verified dangerous". Wired
into `run_service.create_run()` (before persistence, alongside
`validate_workload_limits`/`validate_target_compatibility`) and into
`POST /api/v1/targets/discover`.

## 8. OpenAPI document size cap

`MAX_OPENAPI_DOC_BYTES` (default 5 MiB, env-configurable). **Honest
limitation**: `httpx.get()` already fully downloads the response before
this check runs (a true streaming cap would need `httpx.stream()`, which
would require rewriting `tests/k6_engine/test_openapi_loader.py`'s
`monkeypatch.setattr(httpx, "get", ...)`-based mocks for no behavioral
gain at this project's scale — single, small, demo-API-sized documents).
This bounds how large a document is subsequently parsed/held in memory,
not how many bytes were transferred over the wire.

## 9. Timeouts, redirects

- Fetch timeout: unchanged, pre-existing `timeout_s=10.0` default on every
  `httpx.get()` call.
- Redirects: `httpx.get()`'s default (`follow_redirects=False`) was
  already in effect before this work — a 3xx response fails the existing
  `response.status_code != 200` check and is rejected as `OpenAPILoadError`
  before any redirect is ever followed. No new code was needed for this;
  documenting it here because Session 2 asked the question explicitly.

## 10. What Session 3 should build on

- The nested-`$ref` payload-generation gap (`docs/target_api_notes.md`
  §6) is still unresolved and independent of this work.
- `target_context_store.py`'s single-process limitation (§4) should be
  revisited if/when this backend ever moves to a multi-process or
  distributed execution model — this is now load-bearing for **two**
  things (OpenAPI-discovery auth AND real k6-execution auth), not one.
- No protected real target exists anywhere in this repo — Session 2.5's
  real end-to-end proof (`tests/k6_engine/test_auth_propagation_execution.py`)
  uses a purpose-built local stdlib `http.server` stub (the same
  established pattern `test_engine_exit_semantics.py` already used for its
  native-threshold test), not the canonical demo API, because the demo API
  has no endpoint that requires or echoes auth. If a genuinely
  auth-protected demo target is ever wanted for a richer demo/gate-review
  story, that is new scope, not a gap in this session's verification.

## 11. Session 2.5 — real k6 target-traffic authentication (summary)

**Closed the gap** documented in the old §5: `TargetConfig.auth` now
authenticates BOTH the OpenAPI-discovery fetch (Sessions 1/2, unchanged)
AND every real HTTP request the generated k6 script makes (new). See §5
above for the full mechanism (k6's `__ENV`, never literal interpolation)
and the acceptance-criteria diagram this closes:

```
User
  |
TargetConfig
  |-- OpenAPI URL --> authenticated OpenAPI discovery         (Sessions 1/2)
  `-- Auth        --> secure runtime injection (k6 __ENV) --> k6 --> authenticated API calls   (Session 2.5)

LLM --> sanitized auth metadata only --> NO raw secret        (unchanged, all sessions)
```

Verified for real, not just asserted: `tests/k6_engine/test_auth_propagation_execution.py`
runs the actual k6 v2.2.0 binary against a local header-capturing stub
server and confirms the `Authorization`/custom API-key header the target
*actually receives* matches the configured secret, for both supported
auth types, for the `/checkout`→`/cart` dependency chain, and confirms the
secret appears in none of `script.js`/`results.json`/`stdout.log`/`stderr.log`.
No change to `TestPlan`, the database schema, or any persisted field was
needed — the system still does not depend on storing the raw credential
anywhere but the ephemeral, single-process `target_context_store`.
