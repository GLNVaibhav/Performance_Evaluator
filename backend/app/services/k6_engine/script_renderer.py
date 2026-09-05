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
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List, Optional

from app.schemas.enums import ObjectiveType
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
    """k6 request-params object literal. Producing the exact same string as
    before when tag_alias is None keeps every pre-existing rendered-script
    assertion (tests/k6_engine/test_script_renderer*.py) unchanged."""
    parts = []
    if include_headers:
        parts.append("headers: { 'Content-Type': 'application/json' }")
    if tag_alias is not None:
        parts.append(f"tags: {{ endpoint: {json.dumps(tag_alias)} }}")
    return "{ " + ", ".join(parts) + " }"


def _request_snippet(resolved: ResolvedEndpoint, var_prefix: str, tag_alias: Optional[str]) -> tuple[str, str]:
    """Returns (js_statements, response_variable_name)."""
    method = resolved.spec.method
    url_expr = _js_url_expr(resolved.resolved_path)
    res_var = f"res_{var_prefix}"

    if method == "get":
        if tag_alias is None:
            return f"const {res_var} = http.get({url_expr});", res_var
        return f"const {res_var} = http.get({url_expr}, {_params_js(tag_alias, include_headers=False)});", res_var

    body = generate_request_body(resolved.spec.request_schema)
    body_json = json.dumps(body if body is not None else {})
    params_js = _params_js(tag_alias, include_headers=True)
    stmt = f"const {res_var} = http.{method}({url_expr}, JSON.stringify({body_json}), {params_js});"
    return stmt, res_var


def _render_checkout_with_cart_dependency(
    spec: NormalizedOpenAPI, checkout: ResolvedEndpoint, checkout_tag_alias: str
) -> str:
    cart_candidates = resolve_selected_endpoints(spec, [_CART_PATH])
    cart_resolved = cart_candidates[0]
    cart_body = generate_request_body(cart_resolved.spec.request_schema)
    checkout_body = generate_request_body(checkout.spec.request_schema) or {}
    cart_url_expr = _js_url_expr(cart_resolved.resolved_path)
    checkout_url_expr = _js_url_expr(checkout.resolved_path)
    checkout_params_js = _params_js(checkout_tag_alias, include_headers=True)

    return f"""\
  // Special-cased dependency: /checkout requires a real cart_id from a
  // prior /cart call -- see script_renderer.py module docstring. The
  // /cart call below is intentionally untagged: it is an internal
  // dependency of the /checkout experiment, not itself a selected
  // endpoint, so it is not reported as separate per-endpoint evidence.
  const cartRes = http.post(
    {cart_url_expr},
    JSON.stringify({json.dumps(cart_body)}),
    {{ headers: {{ 'Content-Type': 'application/json' }} }}
  );
  let cartId = null;
  try {{ cartId = JSON.parse(cartRes.body).cart_id; }} catch (e) {{ cartId = null; }}
  const checkoutBody = Object.assign({{}}, {json.dumps(checkout_body)}, {{ cart_id: cartId }});
  const res_checkout = http.post(
    {checkout_url_expr},
    JSON.stringify(checkoutBody),
    {checkout_params_js}
  );
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


def render_script(plan: TestPlan, target: TargetConfig, spec: NormalizedOpenAPI) -> str:
    resolved_endpoints = resolve_selected_endpoints(spec, plan.selected_endpoints)
    endpoint_tags = build_endpoint_tags(plan, spec)

    request_blocks: list[str] = []
    for i, resolved in enumerate(resolved_endpoints):
        tag_alias = endpoint_tags[i].alias
        if resolved.spec.path == _CHECKOUT_PATH and resolved.spec.method == "post":
            request_blocks.append(_render_checkout_with_cart_dependency(spec, resolved, tag_alias))
        else:
            stmt, res_var = _request_snippet(resolved, str(i), tag_alias)
            request_blocks.append(
                f"  {stmt}\n  check({res_var}, {{ 'status is not zero (request completed)': (r) => r.status !== 0 }});\n"
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

export default function () {{
{dispatch}
  sleep(0.2);
}}
"""
