# Release Verification — v1.0.0

> Final operational record for the feature-frozen release: verification
> facts, the required limitation statements, and the credential-rotation
> log (no secret values are ever recorded in this file).

## A. Production bridge

> **The production execution bridge was unavailable during final
> verification, so production E2E execution is UNVERIFIED.**

The configured `EXECUTION_BRIDGE_URL` points at an expired ephemeral
quick tunnel (the hostname no longer resolves; general workspace egress
was confirmed working at the same time). No replacement tunnel was
created and no workaround was substituted. All claims about the
Convex → FastAPI → k6 → Convex round trip in this repository are
therefore **local-execution verified only** (real k6 subprocess + real
FastAPI parsing in the test suite), never production-E2E verified.

## B. REAL_PROBE — bounded real HTTP probe

REAL_PROBE is a **bounded real HTTP probe**, not a load test. Actual
implementation limits (`src/convex/probe.ts`):

- **Bounded request count:** ≤ 30 measured requests per probe volley.
- **Bounded concurrency:** ≤ 4 requests in flight at once (jittered
  volleys, ≥ 120 ms between bursts).
- **GET-oriented:** GET only, no request bodies, no stateful flows
  (no cart/checkout semantics).
- **Wall-clock bound:** ≤ 8 s total, ≤ 4 s per request timeout.
- **No sustained VU load:** it cannot hold a VU population over time;
  there is no ramp, no hold, no open/closed workload model.
- **No capacity inference:** no saturation or breaking-point claims are
  derived from probe data; the UI states this explicitly.
- **No stress/soak equivalence:** a probe result is not a stress or soak
  result and must never be presented as one.
- **Honest concurrency reporting:** the measured peak in-flight probe
  concurrency must not be presented as the requested VUs. Requested VU
  envelopes are shown as context only, never as measured load.

Every hop of the probe (initial URL and each redirect) is
scheme-validated and host-validated, with `MAX_REDIRECTS = 3`.

## C. Boundary search

> **The adaptive boundary search identifies an observed performance
> boundary within the tested workload/range. It does not establish exact
> system capacity.**

The controller runs deterministic experiments (ramp + hold plans) against
the authorized target, classifies each outcome from backend threshold
results, and narrows a bracket of observed pass/fail VU levels. It never
claims mathematical certainty, an exact maximum capacity, or a guarantee
beyond the VU range actually tested. On `EXECUTION_ERROR` it records and
terminalizes honestly instead of extrapolating.

## D. Simulation

> **SIMULATION is an offline/development execution mode and is not
> equivalent to live performance testing.**

Simulation results are modeled outputs of a deterministic k6-style
closed-load model — never measurements of a real target. Runs are
labeled with their execution mode (`live_k6` | `real` | `simulation`)
in the schema, the API, and the UI badge; simulation numbers must never
be described as real target measurements.

## E. k6 version

- **Verified binary: k6 v0.57.0** (`k6 version` output; matches the
  `Dockerfile.backend` pin `K6_VERSION=v0.57.0`).
- The final real-execution verification — golden path against the
  canonical demo API, the 4 real-k6 integration tests, and the 5
  redirect-security executions — was performed with this version.

## F. Security — final redirect behavior

- k6 **automatic redirects are disabled** for all generated requests
  (`redirects: 0` pinned in the single request wrapper).
- **Redirect hops are explicitly validated** before any follow:
  scheme (http/https only), no embedded credentials, host policy check.
- **Validation uses the applicable target-safety policy** — the same
  policy classes as `target_url_safety.py`, embedded at render time
  from `TARGET_SSRF_POLICY` (cloud-metadata/link-local always blocked;
  private/loopback blocked under `block_private`).
- **Hop limits are enforced:** at most 3 redirect hops, identical to
  the probe's policy; the next hop is never followed past the limit.
- **Unsafe or unverifiable destinations fail closed:** a redirect host
  that is neither the authorized target host nor a statically
  validatable IP literal is refused, and the refused destination
  receives zero traffic (proven by hit-count tests).
- **Honest evidence:** refused/limited redirects are still measured as
  the observed 3xx, with always-true `redirect_blocked_*` /
  `redirect_not_followed_*` checks recording the reason.

This is defense in depth, **not perfect SSRF protection**: documented
pre-existing gaps remain (resolve-then-check is not atomic against DNS
rebinding; k6 performs its own DNS at request time; the authorized
target's own hostname is trusted as validated upstream).

## Verified test evidence

| Suite | Result | Command exit |
|---|---|---|
| Backend (pytest, full) | **517 passed, 5 skipped, 0 failed** | 0 |
| Focused redirect/security + renderer | **62 passed** | 0 |
| Real k6 integration (demo API) | **4 passed** | 0 |
| Convex/Bun | **179 pass, 0 fail** | 0 |
| TypeScript (`bun tsc -b --noEmit`) | clean | 0 |
| Controlled demo-API execution | `PASS`, 50 requests, `results.json` parsed | 0 |

Skip report (identical before and after remediation, all pre-existing
predicates that do not detect the installed k6 binary):
`test_engine_exit_semantics.py:162` (1) and
`test_bridge_live_failure_semantics.py:68,77,92,107` (4).

## Credential rotation log (no values recorded)

Three Convex-deployment env secrets required rotation after a faulty
transient display during the remediation session:

| Secret | Action | Verification |
|---|---|---|
| `EXECUTION_BRIDGE_TOKEN` | **Rotated** (new 64-hex value generated in-shell, never displayed) | variable exists, well-formed (64 chars); end-to-end use unverifiable while the bridge is down — when the bridge is redeployed, the same new value must be configured in the backend environment |
| `JWT_PRIVATE_KEY` + `JWKS` | **Rotated together** as a matched RSA-2048/RS256 pair (values never displayed; temp key material removed) | both variables exist; `/.well-known/jwks.json` serves the new public half; a real app-signed access JWT from `auth:signIn` verifies cryptographically against it; sign-in succeeds (existing sessions must re-authenticate) |
| `LLM_API_KEY` | **NOT rotatable from this environment** — provider console required | Manual action required: revoke the exposed key in the OpenRouter console, create a replacement, and set it via `bun convex env set LLM_API_KEY <value>` (or Freebuff Settings → Environment); unset in Convex falls back safely to the deterministic interpreter |

No secret values appear in this file, in the repository, or in any
commit.
