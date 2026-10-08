"""Render a k6 script from a resolved TestPlan.

One target_vus per invocation, per the frozen invariant (section 3):
boundary_search is a single ramp+hold experiment, fixed_load is a single
flat VU/duration block. Neither is ever a multi-stage candidate ladder.

Special-cased dependency (section 11's explicitly-sanctioned "minimal
mechanism", not a generic workflow engine): the canonical demo API's
POST /checkout requires a cart_id that only exists after a prior
POST /cart call -- hitting /checkout cold 404s on every single request
regardless of demo mode, which would make the checkout_bottleneck and any
/checkout-based scenario meaningless. When /checkout is a selected
endpoint, the rendered script always creates a cart first (in the same
iteration) and threads its cart_id into the checkout body. This is one
hardcoded case for one known dependency in the canonical target, not a
general dependency resolver.

SECURITY: every dynamic value that reaches the generated script (base_url,
OpenAPI-derived resolved paths -- which may themselves come from an
externally-fetched target spec) is encoded via json.dumps() into a JS
string literal and never interpolated into a backtick template literal or
a naively-quoted string. See _js_url_expr(). Regression tests:
tests/k6_engine/test_script_renderer.py.

--- Endpoint mix + per-endpoint evidence (additive amendment) ------------

Two things were added on top of the above, both documented in
docs/performance_engine_interface.md ("Amendment: endpoint mix +
per-endpoint evidence"):

1. Weighted dispatch: when plan.endpoint_weights is set, each VU
   iteration's single random draw is bucketed by the configured weights
   instead of split evenly. Omitting it reproduces the original uniform
   behaviour exactly (same statistical distribution as the prior
   `Math.floor(Math.random() * N)` bucketing).

2. Per-endpoint tagging: every request is tagged `{ endpoint: <alias> }`
   where <alias> is a backend-generated, ASCII-safe identifier
   (`endpoint_0`, `endpoint_1`, ...) -- NEVER the raw selected_endpoints
   text. This matters for injection safety, not just style: the alias is
   also embedded in a k6 threshold-selector string
   (`metric{endpoint:alias}`), which is parsed by k6's own Go threshold
   grammar, a completely different parser from the JS engine that
   receives the (separately, already-safely-encoded) URL. Reusing
   externally-influenced path text there would open a second, unrelated
   injection surface that _js_url_expr's json.dumps encoding does nothing
   to protect. A closed alphabet (`endpoint_<int>`) makes that surface
   moot rather than merely escaped.

   Plain tagging alone does not make k6 report a per-tag breakdown in
   --summary-export -- verified empirically against the pinned k6 v2.2.0
   binary (see docs/performance_engine_interface.md for the spike). The
   mechanism that actually works, staying inside the frozen
   --summary-export artifact contract (no NDJSON): reference the tagged
   submetric in a threshold expression. See _thresholds_js() -- the
   emitted thresholds are tautologies (`>=0` on non-negative metrics) so
   they can never affect k6's own exit code; the execution-failure vs.
   performance-failure distinction and threshold_evaluator.py's own
   PASS/FAIL rule are both completely unaffected by this.

   The one exception: the auto-generated /cart call inside the
   checkout-dependency special case is deliberately left untagged. It is
   an internal dependency of the /checkout experiment, not itself a
   selected endpoint, so it must not be reported as separate per-endpoint
   evidence (it still contributes to the aggregate metrics as before,
   unchanged).

--- Target authentication (additive amendment) ----------------------------

Every real HTTP request this script makes (GET, POST/PUT/PATCH/DELETE, and
the auto-generated /cart call inside the checkout dependency) is given a
chance to carry an authentication header, via a fixed, generic
`AUTH_HEADERS` object built ONCE at module/init scope:

    const AUTH_HEADER_NAME = __ENV.PERF_EVAL_AUTH_HEADER_NAME || '';
    const AUTH_HEADER_VALUE = __ENV.PERF_EVAL_AUTH_HEADER_VALUE || '';
    const AUTH_HEADERS = AUTH_HEADER_NAME ? { [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE } : {};

CRITICAL: the real secret is NEVER interpolated into this generated
source. It reaches k6 exclusively via k6's own `__ENV` mechanism -- a
process environment variable set only on the k6 SUBPROCESS
(app/services/k6_engine/k6_runner.py's `env` parameter, populated by
app/services/auth_headers.py::build_auth_env()) -- so `script.js` on disk
contains only the two fixed, non-secret ENV-VAR NAMES, never a value. When
no auth is configured, both env vars are simply absent/empty and
`AUTH_HEADERS` evaluates to `{}` -- byte-for-byte the same "no extra
headers" behavior this renderer had before this amendment. This is one
generic mechanism for both supported auth types (`bearer`, `api_key_header`)
-- both resolve to exactly one (header name, header value) pair upstream
(app/services/auth_headers.py::build_auth_headers()), so the script never
needs to know which type was configured.

Every request's `headers` object is built via `Object.assign({}, AUTH_HEADERS,
<whatever headers this request already needed>)` -- the same merge pattern
`_render_checkout_with_cart_dependency` already used for the checkout body
(`Object.assign({}, <base>, {cart_id: cartId})`), reused here rather than
introducing object-spread syntax as a second, redundant merging idiom.
See docs/target_auth_contract.md for the full design and its documented
tradeoff (this authenticates real k6 target traffic; it does NOT change
how the OpenAPI *discovery* fetch is authenticated -- that is a separate,
Python-side-only concern, app/services/target_validation.py /
app/services/k6_engine/engine.py's own `build_auth_headers()` call).

--- Payload strategy (Session 3, additive) ---------------------------------

`plan.payload_strategy` (app/schemas/test_plan.py, defaults to `normal`)
is threaded straight through to every `generate_request_body()` call this
renderer makes (both `_request_snippet()` and the checkout/cart special
case) -- selecting between payload_generator.py's two fixed, deterministic
generation rules. Nothing here decides WHICH values are generated; this
renderer only ever passes the plan's own choice along, unchanged.

--- HTTP status-code evidence (Session 5, additive) -------------------------

k6's `--summary-export` (the frozen MVP artifact contract) has no built-in
per-status-code breakdown -- confirmed by inspecting real captured k6
v2.2.0 output (tests/k6_engine/fixtures/*.json,
demo-api/tools/k6_*_summary.json) before adding anything. What IS already
present, unconditionally, with no threshold trick required (unlike the
per-endpoint tagged submetrics above): `root_group.checks`, keyed by
whatever name a `check()` call in the script used.

Verified empirically (see docs/performance_engine_interface.md's
"HTTP status-code evidence" section for the exact probe): a `check()` call
whose NAME is computed dynamically per response --
`check(res, { ['http_status_' + res.status]: () => true })` -- makes k6
aggregate PASS COUNTS per distinct observed status value, e.g.
`http_status_200: {passes: 950}`, `http_status_404: {passes: 30}`,
appearing ONLY for statuses actually observed (never a hardcoded list).
The check condition is always true (`() => true`), so -- like the
tautological per-endpoint thresholds above -- this can never fail and
never affects k6's exit code. `res.status === 0` (k6's own convention for
"no response received", e.g. connection refused) is recorded the same way
(`http_status_0`) -- real evidence of a failure mode, not a fabricated
code. `recordHttpStatus()` (defined once, called after every real
request this script makes, including the checkout/cart special case) is
the one small, additive collection change this required.

--- Redirect safety (audit remediation) -------------------------------------

k6 follows HTTP redirects by default (verified empirically against the
pinned k6 v0.57.0 binary: a bare http.get() on a 302 chases the Location
without any application-level validation), which meant the ACTUAL load
phase bypassed every redirect validation the application performs elsewhere
(the probe's manual-redirect contract in src/convex/probe.ts and the
OpenAPI fetch's follow_redirects=False in openapi_loader.py). An authorized
target could therefore 302 the real k6 load to a destination the SSRF
policy (app/services/target_url_safety.py) never approved.

FIX (this renderer only -- no new execution engine, no k6 CLI flags, and
the existing target-safety policy is unchanged):

1. Every request the script makes is emitted as a call to
   requestWithRedirectPolicy(method, url, body, params) -- including the
   auto-generated /cart + /checkout calls. The wrapper injects
   `redirects: 0` into every request's params, so k6 NEVER auto-follows.
2. Each 3xx response is re-validated hop by hop before any follow:
   http/https only; no embedded credentials; cloud-metadata/link-local
   destinations always blocked; private/loopback destinations blocked iff
   TARGET_SSRF_POLICY=block_private (same policy classes as
   target_url_safety.py, embedded at render time); at most MAX_REDIRECTS
   (3) hops -- identical to probe.ts's hop policy.
3. A redirect whose host is neither the authorized target host nor a
   statically validatable IP literal is REFUSED. k6 has no DNS API, so the
   application's resolve-then-check cannot be replicated in-script; the
   invariant "an unvalidated redirect destination must never become a k6
   load target" is therefore enforced fail-closed. This is deliberately
   STRICTER than, never weaker than, the application policy (documented
   gap: cross-host redirects to hostnames are never followed).
4. A refused/over-limit redirect is returned to the caller UNFOLLOWED --
   the 3xx itself is the measured response (recorded via recordHttpStatus),
   and an always-true `redirect_not_followed_*` / `redirect_blocked_*`
   check records WHY, so the run stays honest without ever touching the
   refused destination.

Regression tests: tests/k6_engine/test_redirect_security.py (render-level
invariants + REAL k6 executions against controlled local redirect servers).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import urlparse

from app.core.config import TARGET_SSRF_POLICY
from app.schemas.enums import ObjectiveType, PayloadStrategy
from app.schemas.test_plan import TargetConfig, TestPlan
from app.services.k6_engine.endpoint_resolver import ResolvedEndpoint, resolve_selected_endpoints
from app.services.k6_engine.openapi_loader import NormalizedOpenAPI
from app.services.k6_engine.payload_generator import generate_request_body

_CHECKOUT_PATH = "/checkout"
_CART_PATH = "/cart"


@dataclass
class EndpointTagInfo:
    """Maps one plan.selected_endpoints entry to the k6 tag alias used for
    it in the rendered script, so metrics_parser can look up the matching
    tagged submetrics and label the result back with the real endpoint
    string. `alias` is always `endpoint_<i>` -- see module docstring for
    why it is never the raw endpoint text."""

    alias: str
    endpoint: str
    method: str


def _alias_for(index: int) -> str:
    return f"endpoint_{index}"


def build_endpoint_tags(plan: TestPlan, spec: NormalizedOpenAPI) -> List[EndpointTagInfo]:
    """Independent of render_script() on purpose: engine.py calls this to
    get the alias list metrics_parser needs, while render_script() keeps
    its existing `-> str` return type so every current caller/test is
    unaffected. Both derive the identical `endpoint_<i>` scheme from the
    same (plan, spec) inputs, so they can never disagree."""
    resolved = resolve_selected_endpoints(spec, plan.selected_endpoints)
    return [
        EndpointTagInfo(alias=_alias_for(i), endpoint=endpoint, method=resolved_endpoint.spec.method.upper())
        for i, (endpoint, resolved_endpoint) in enumerate(zip(plan.selected_endpoints, resolved))
    ]


def _endpoint_weights(plan: TestPlan) -> List[float]:
    """Normalized (sum to 1.0) weight per plan.selected_endpoints entry, in
    order. Uniform when plan.endpoint_weights is unset -- this is what
    keeps "no weights specified" behaviourally identical to before endpoint
    mix existed."""
    n = len(plan.selected_endpoints)
    if not plan.endpoint_weights:
        return [1.0 / n] * n
    raw = [plan.endpoint_weights[endpoint] for endpoint in plan.selected_endpoints]
    total = sum(raw)
    return [w / total for w in raw]


def _cumulative_thresholds(weights: List[float]) -> List[float]:
    cumulative: List[float] = []
    running = 0.0
    for w in weights:
        running += w
        cumulative.append(running)
    # Guard against float drift leaving a sliver of [0,1) unmapped -- the
    # last branch is generated as a bare `else` anyway (see
    # _weighted_dispatch_js), so this value is never actually compared
    # against, but keeping it exact avoids a misleading number if ever
    # inspected/logged.
    cumulative[-1] = 1.0
    return cumulative


def _thresholds_js(endpoint_tags: List[EndpointTagInfo]) -> str:
    """Tautological per-endpoint threshold expressions -- the verified
    mechanism (see module docstring) for making k6 include a tagged
    submetric in --summary-export. Every condition is true for every
    possible metric value, so these can never fail and can never affect
    k6's exit code."""
    lines = []
    for tag in endpoint_tags:
        selector = f"endpoint:{tag.alias}"
        lines.append(f"    'http_req_duration{{{selector}}}': ['p(95)>=0'],")
        lines.append(f"    'http_reqs{{{selector}}}': ['count>=0'],")
        lines.append(f"    'http_req_failed{{{selector}}}': ['rate>=0'],")
    return "\n".join(lines)


def _stages_js(plan: TestPlan) -> str:
    if plan.objective_type == ObjectiveType.boundary_search:
        return (
            f"{{ duration: '{plan.ramp_duration}', target: {plan.target_vus} }},\n"
            f"        {{ duration: '{plan.hold_duration}', target: {plan.target_vus} }},"
        )
    return f"{{ duration: '{plan.duration}', target: {plan.target_vus} }},"


def _js_url_expr(resolved_path: str) -> str:
    """BASE_URL + <safe JSON-encoded path literal>.

    Deliberately never builds a backtick template literal with dynamic
    content -- `${...}` and backtick have no special meaning inside a
    json.dumps-produced double-quoted string, so concatenating two
    already-safe JS string literals with `+` structurally eliminates the
    injection class (quote/backtick/template-expression breakout, newline,
    backslash) rather than merely escaping around it. See BLOCKER 1 fix.
    """
    return f"BASE_URL + {json.dumps(resolved_path)}"


def _params_js(tag_alias: Optional[str], include_headers: bool) -> str:
    """k6 request-params object literal. `headers` is now ALWAYS present
    (merging AUTH_HEADERS -- see module docstring's "Target authentication"
    section -- with whatever headers this request already needed), which
    is a source-level change from before that amendment (a bare/untagged
    GET previously received no params object, let alone a headers key) --
    but AUTH_HEADERS evaluates to `{}` when no auth is configured, so the
    ACTUAL header set sent by k6 is unchanged for every existing no-auth
    caller; only the generated source text gained this one constant,
    always-present `headers: Object.assign({}, AUTH_HEADERS, ...)` clause."""
    extra_headers = "{ 'Content-Type': 'application/json' }" if include_headers else "{}"
    parts = [f"headers: Object.assign({{}}, AUTH_HEADERS, {extra_headers})"]
    if tag_alias is not None:
        parts.append(f"tags: {{ endpoint: {json.dumps(tag_alias)} }}")
    return "{ " + ", ".join(parts) + " }"


def _request_snippet(
    resolved: ResolvedEndpoint,
    var_prefix: str,
    tag_alias: Optional[str],
    strategy: PayloadStrategy = PayloadStrategy.normal,
) -> tuple[str, str]:
    """Returns (js_statements, response_variable_name). Every request --
    GET included, regardless of whether it carries a per-endpoint tag --
    now always passes a params object, so AUTH_HEADERS reaches every real
    request k6 makes (see module docstring). `strategy` (Session 3,
    additive) selects which of payload_generator.py's two deterministic
    generation rules builds this request's body -- defaulting to `normal`
    reproduces the exact prior behavior for every existing caller."""
    method = resolved.spec.method
    url_expr = _js_url_expr(resolved.resolved_path)
    res_var = f"res_{var_prefix}"

    if method == "get":
        params_js = _params_js(tag_alias, include_headers=False)
        return f'const {res_var} = requestWithRedirectPolicy("get", {url_expr}, null, {params_js});', res_var

    body = generate_request_body(resolved.spec.request_schema, strategy)
    body_json = json.dumps(body if body is not None else {})
    params_js = _params_js(tag_alias, include_headers=True)
    stmt = (
        f'const {res_var} = requestWithRedirectPolicy({json.dumps(method)}, {url_expr}, '
        f"JSON.stringify({body_json}), {params_js});"
    )
    return stmt, res_var


def _render_checkout_with_cart_dependency(
    spec: NormalizedOpenAPI,
    checkout: ResolvedEndpoint,
    checkout_tag_alias: str,
    strategy: PayloadStrategy = PayloadStrategy.normal,
) -> str:
    cart_candidates = resolve_selected_endpoints(spec, [_CART_PATH])
    cart_resolved = cart_candidates[0]
    cart_body = generate_request_body(cart_resolved.spec.request_schema, strategy)
    checkout_body = generate_request_body(checkout.spec.request_schema, strategy) or {}
    cart_url_expr = _js_url_expr(cart_resolved.resolved_path)
    checkout_url_expr = _js_url_expr(checkout.resolved_path)
    checkout_params_js = _params_js(checkout_tag_alias, include_headers=True)

    return f"""\
  // Special-cased dependency: /checkout requires a real cart_id from a
  // prior /cart call -- see script_renderer.py module docstring. The
  // /cart call below is intentionally untagged: it is an internal
  // dependency of the /checkout experiment, not itself a selected
  // endpoint, so it is not reported as separate per-endpoint evidence.
  const cartRes = requestWithRedirectPolicy("post",
    {cart_url_expr},
    JSON.stringify({json.dumps(cart_body)}),
    {{ headers: Object.assign({{}}, AUTH_HEADERS, {{ 'Content-Type': 'application/json' }}) }}
  );
  recordHttpStatus(cartRes);
  let cartId = null;
  try {{ cartId = JSON.parse(cartRes.body).cart_id; }} catch (e) {{ cartId = null; }}
  const checkoutBody = Object.assign({{}}, {json.dumps(checkout_body)}, {{ cart_id: cartId }});
  const res_checkout = requestWithRedirectPolicy("post",
    {checkout_url_expr},
    JSON.stringify(checkoutBody),
    {checkout_params_js}
  );
  recordHttpStatus(res_checkout);
  check(res_checkout, {{ 'checkout: got a response': (r) => r.status !== 0 }});
"""


def _weighted_dispatch_js(request_blocks: List[str], cumulative: List[float]) -> str:
    """One Math.random() draw, bucketed by cumulative weight thresholds.
    With uniform weights (the default when plan.endpoint_weights is unset)
    this produces the same per-endpoint selection PROBABILITY as the prior
    `Math.floor(Math.random() * N)` bucketing -- not byte-identical
    generated JS, but the same traffic split, which is the behaviour the
    "preserve uniform behaviour by default" requirement is actually about.
    """
    n = len(request_blocks)
    lines = ["  const r = Math.random();"]
    for i, block in enumerate(request_blocks):
        if i == 0:
            lines.append(f"  if (r < {round(cumulative[i], 6)}) {{\n{block}  }}")
        elif i == n - 1:
            lines.append(f"  else {{\n{block}  }}")
        else:
            lines.append(f"  else if (r < {round(cumulative[i], 6)}) {{\n{block}  }}")
    return "\n".join(lines) + "\n"


# --- Redirect safety (audit remediation) ------------------------------------
# The JS below is embedded verbatim into every rendered script; the two
# __PLACEHOLDER__ tokens are substituted by _redirect_policy_block() at
# render time. Deliberately a plain (non-f, raw) string: the body is full of
# JS braces, regex backslashes and `{{`-free literals that an f-string would
# mangle. See the module docstring's "Redirect safety" section.
_REDIRECT_JS_TEMPLATE = r'''
// --- Redirect safety (see module docstring) ---------------------------------
// k6 follows HTTP redirects by default; this script NEVER does. Every request
// is issued through requestWithRedirectPolicy(), which pins `redirects: 0`
// and re-validates each 3xx hop against the same target-safety policy the
// application applies before execution (target_url_safety.py / probe.ts):
//   http/https only, no embedded credentials, cloud-metadata/link-local
//   destinations always blocked, private/loopback destinations blocked iff
//   ALLOW_PRIVATE is false (TARGET_SSRF_POLICY=block_private), at most
//   MAX_REDIRECTS (3) hops -- and a host that is neither the authorized
//   target host nor a statically validatable IP literal is REFUSED
//   (k6 has no DNS API -- fail closed, never follow an unvalidated hop).
// A refused/over-limit redirect is returned UNFOLLOWED: the 3xx itself is
// the measured response and the refused destination receives zero traffic.
const MAX_REDIRECTS = 3; // same hop policy as probe.ts::MAX_REDIRECTS
const ALLOW_PRIVATE = __ALLOW_PRIVATE__;
const TARGET_HOST = __TARGET_HOST__;

function redirectOrigin(u) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)([^\/?#]*)/.exec(u);
  return m ? m[1] + m[2] : null;
}

function redirectDirPath(u) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\/?#]*(\/[^?#]*)?/.exec(u);
  const path = m && m[1] ? m[1] : "/";
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function resolveRedirectUrl(currentUrl, location) {
  const loc = String(location).trim();
  if (loc === "") return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(loc)) return loc; // absolute; scheme re-checked below
  if (loc.slice(0, 2) === "//") {
    const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)/.exec(currentUrl);
    return m ? m[1] + loc : null;
  }
  const origin = redirectOrigin(currentUrl);
  if (origin === null) return null;
  if (loc.charAt(0) === "/") return origin + loc;
  return origin + redirectDirPath(currentUrl) + loc;
}

function parseRedirectAuthority(url) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#]*)/.exec(url);
  if (!m) return { ok: false, check: "redirect_blocked_unparseable" };
  const authority = m[1];
  if (authority.indexOf("@") !== -1) return { ok: false, check: "redirect_blocked_credentials" };
  let host = authority;
  if (host.charAt(0) === "[") {
    const end = host.indexOf("]");
    if (end === -1) return { ok: false, check: "redirect_blocked_unparseable" };
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "") return { ok: false, check: "redirect_blocked_unparseable" };
  return { ok: true, host: host };
}

function isIpLiteralHost(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(":") !== -1;
}

// Same policy classes as app/services/target_url_safety.py, evaluated
// statically (k6 has no DNS resolution API): cloud-metadata/link-local
// unconditionally, private ranges only when TARGET_SSRF_POLICY permits.
function redirectHostBlockReason(host) {
  const h = host;
  if (h === "169.254.169.254" || h === "100.100.100.200" || h === "metadata.google.internal") {
    return "redirect_blocked_metadata_host";
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return "redirect_blocked_unparseable";
    if (a === 169 && b === 254) return "redirect_blocked_metadata_host"; // 169.254.0.0/16
    if (a === 100 && b === 100 && c === 100 && d === 200) return "redirect_blocked_metadata_host";
    if (!ALLOW_PRIVATE) {
      if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return "redirect_blocked_private_host";
      }
    }
    return null;
  }
  if (h.indexOf(":") !== -1) {
    if (/^fe[89ab]/.test(h)) return "redirect_blocked_metadata_host"; // fe80::/10
    if (!ALLOW_PRIVATE && (/^f[cd]/.test(h) || h === "::1" || h === "::")) {
      return "redirect_blocked_private_host";
    }
    return null;
  }
  if (!ALLOW_PRIVATE && (h === "localhost" || /\.localhost$/.test(h))) {
    return "redirect_blocked_private_host";
  }
  return null;
}

function checkRedirectDestination(currentUrl, location) {
  const next = resolveRedirectUrl(currentUrl, location);
  if (next === null) return { ok: false, check: "redirect_blocked_unparseable" };
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(next);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, check: "redirect_blocked_scheme" };
  }
  const parsed = parseRedirectAuthority(next);
  if (!parsed.ok) return parsed;
  const reason = redirectHostBlockReason(parsed.host);
  if (reason !== null) return { ok: false, check: reason };
  if (parsed.host === TARGET_HOST) return { ok: true, url: next }; // authorized target host
  if (isIpLiteralHost(parsed.host)) return { ok: true, url: next }; // statically validated above
  return { ok: false, check: "redirect_blocked_unvalidated_host" };
}

function requestWithRedirectPolicy(method, url, body, params) {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  let hop = 0;
  while (true) {
    const p = Object.assign({}, params, { redirects: 0 }); // k6 never auto-follows
    let res;
    if (currentMethod === "get" || currentMethod === "head") {
      res = http[currentMethod](currentUrl, p);
    } else {
      res = http[currentMethod](currentUrl, currentBody, p);
    }
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers["Location"] || res.headers["location"];
    if (!location) {
      check(res, { redirect_not_followed_no_location: () => true });
      return res;
    }
    if (hop >= MAX_REDIRECTS) {
      check(res, { redirect_not_followed_hop_limit: () => true });
      return res;
    }
    const verdict = checkRedirectDestination(currentUrl, location);
    if (!verdict.ok) {
      check(res, { [verdict.check]: () => true });
      return res;
    }
    // This hop is about to be followed: record its status exactly once here;
    // the chain's FINAL response is recorded by the caller (recordHttpStatus
    // after the wrapper returns), so every observed status counts once.
    recordHttpStatus(res);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== "get")) {
      currentMethod = "get";
      currentBody = null;
    }
    currentUrl = verdict.url;
    hop += 1;
  }
}
'''


def _redirect_policy_block(target: TargetConfig) -> str:
    """Embed the target-safety policy classes into the script's redirect
    validator at render time (module docstring, "Redirect safety").
    TARGET_SSRF_POLICY is read from this module's global so tests can render
    under a different policy without touching the real environment."""
    try:
        host = (urlparse(target.base_url).hostname or "").lower()
    except ValueError:
        host = ""
    allow_private = TARGET_SSRF_POLICY != "block_private"
    return _REDIRECT_JS_TEMPLATE.replace("__ALLOW_PRIVATE__", "true" if allow_private else "false").replace(
        "__TARGET_HOST__", json.dumps(host)
    )


def render_script(plan: TestPlan, target: TargetConfig, spec: NormalizedOpenAPI) -> str:
    resolved_endpoints = resolve_selected_endpoints(spec, plan.selected_endpoints)
    endpoint_tags = build_endpoint_tags(plan, spec)
    redirect_js = _redirect_policy_block(target)

    request_blocks: list[str] = []
    for i, resolved in enumerate(resolved_endpoints):
        tag_alias = endpoint_tags[i].alias
        if resolved.spec.path == _CHECKOUT_PATH and resolved.spec.method == "post":
            request_blocks.append(
                _render_checkout_with_cart_dependency(spec, resolved, tag_alias, plan.payload_strategy)
            )
        else:
            stmt, res_var = _request_snippet(resolved, str(i), tag_alias, plan.payload_strategy)
            request_blocks.append(
                f"  {stmt}\n"
                f"  recordHttpStatus({res_var});\n"
                f"  check({res_var}, {{ 'status is not zero (request completed)': (r) => r.status !== 0 }});\n"
            )

    if len(request_blocks) == 1:
        dispatch = request_blocks[0]
    else:
        weights = _endpoint_weights(plan)
        cumulative = _cumulative_thresholds(weights)
        dispatch = _weighted_dispatch_js(request_blocks, cumulative)

    thresholds_lines = _thresholds_js(endpoint_tags)
    thresholds_option = f",\n  thresholds: {{\n{thresholds_lines}\n  }}" if thresholds_lines else ""

    return f"""\
import http from 'k6/http';
import {{ check, sleep }} from 'k6';

export const options = {{
  scenarios: {{
    performance_evaluator: {{
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        {_stages_js(plan)}
      ],
      gracefulRampDown: '0s',
    }},
  }}{thresholds_option}
}};

const BASE_URL = {json.dumps(target.base_url)};

// Target authentication (additive; see module docstring). Only the two
// FIXED, NON-SECRET env-var NAMES appear in this source -- the real value,
// if any, exists solely as a k6-subprocess environment variable set by
// app/services/k6_engine/engine.py via app/services/auth_headers.py::
// build_auth_env(), never written here. Absent/unset -> AUTH_HEADERS is
// {{}}, identical to this script's pre-existing no-auth behavior.
const AUTH_HEADER_NAME = __ENV.PERF_EVAL_AUTH_HEADER_NAME || '';
const AUTH_HEADER_VALUE = __ENV.PERF_EVAL_AUTH_HEADER_VALUE || '';
const AUTH_HEADERS = AUTH_HEADER_NAME ? {{ [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE }} : {{}};

// HTTP status-code evidence (additive; see module docstring's "HTTP
// status-code evidence" section). A dynamically-named, always-true check
// per distinct observed status -- k6's --summary-export includes
// root_group.checks unconditionally (no threshold trick needed, unlike
// the per-endpoint tagged submetrics below), so this is the smallest
// mechanism that reports EXACTLY the statuses this run actually observed,
// never a hardcoded/guessed list. Can never fail or affect k6's exit code.
function recordHttpStatus(res) {{
  check(res, {{ ['http_status_' + res.status]: () => true }});
}}

{redirect_js}
export default function () {{
{dispatch}
  sleep(0.2);
}}
"""
