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
"""
from __future__ import annotations

import json

from app.schemas.enums import ObjectiveType
from app.schemas.test_plan import TargetConfig, TestPlan
from app.services.k6_engine.endpoint_resolver import ResolvedEndpoint, resolve_selected_endpoints
from app.services.k6_engine.openapi_loader import NormalizedOpenAPI
from app.services.k6_engine.payload_generator import generate_request_body

_CHECKOUT_PATH = "/checkout"
_CART_PATH = "/cart"


def _stages_js(plan: TestPlan) -> str:
    if plan.objective_type == ObjectiveType.boundary_search:
        return (
            f"{{ duration: '{plan.ramp_duration}', target: {plan.target_vus} }},\n"
            f"        {{ duration: '{plan.hold_duration}', target: {plan.target_vus} }},"
        )
    return f"{{ duration: '{plan.duration}', target: {plan.target_vus} }},"


def _request_snippet(resolved: ResolvedEndpoint, var_prefix: str) -> tuple[str, str]:
    """Returns (js_statements, response_variable_name)."""
    method = resolved.spec.method
    url = f"`${{BASE_URL}}{resolved.resolved_path}`"
    res_var = f"res_{var_prefix}"

    if method == "get":
        return f"const {res_var} = http.get({url});", res_var

    body = generate_request_body(resolved.spec.request_schema)
    body_json = json.dumps(body if body is not None else {})
    stmt = (
        f"const {res_var} = http.{method}({url}, JSON.stringify({body_json}), "
        f"{{ headers: {{ 'Content-Type': 'application/json' }} }});"
    )
    return stmt, res_var


def _render_checkout_with_cart_dependency(spec: NormalizedOpenAPI, checkout: ResolvedEndpoint) -> str:
    cart_candidates = resolve_selected_endpoints(spec, [_CART_PATH])
    cart_resolved = cart_candidates[0]
    cart_body = generate_request_body(cart_resolved.spec.request_schema)
    checkout_body = generate_request_body(checkout.spec.request_schema) or {}

    return f"""\
  // Special-cased dependency: /checkout requires a real cart_id from a
  // prior /cart call -- see script_renderer.py module docstring.
  const cartRes = http.post(
    `${{BASE_URL}}{cart_resolved.resolved_path}`,
    JSON.stringify({json.dumps(cart_body)}),
    {{ headers: {{ 'Content-Type': 'application/json' }} }}
  );
  let cartId = null;
  try {{ cartId = JSON.parse(cartRes.body).cart_id; }} catch (e) {{ cartId = null; }}
  const checkoutBody = Object.assign({{}}, {json.dumps(checkout_body)}, {{ cart_id: cartId }});
  const res_checkout = http.post(
    `${{BASE_URL}}{checkout.resolved_path}`,
    JSON.stringify(checkoutBody),
    {{ headers: {{ 'Content-Type': 'application/json' }} }}
  );
  check(res_checkout, {{ 'checkout: got a response': (r) => r.status !== 0 }});
"""


def render_script(plan: TestPlan, target: TargetConfig, spec: NormalizedOpenAPI) -> str:
    resolved_endpoints = resolve_selected_endpoints(spec, plan.selected_endpoints)

    request_blocks: list[str] = []
    for i, resolved in enumerate(resolved_endpoints):
        if resolved.spec.path == _CHECKOUT_PATH and resolved.spec.method == "post":
            request_blocks.append(_render_checkout_with_cart_dependency(spec, resolved))
        else:
            stmt, res_var = _request_snippet(resolved, str(i))
            request_blocks.append(
                f"  {stmt}\n  check({res_var}, {{ 'status is not zero (request completed)': (r) => r.status !== 0 }});\n"
            )

    if len(request_blocks) == 1:
        dispatch = request_blocks[0]
    else:
        branches = "\n".join(
            f"  {'if' if i == 0 else 'else if'} (choice === {i}) {{\n{block}  }}"
            for i, block in enumerate(request_blocks)
        )
        dispatch = f"  const choice = Math.floor(Math.random() * {len(request_blocks)});\n{branches}\n"

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
  }},
}};

const BASE_URL = '{target.base_url}';

export default function () {{
{dispatch}
  sleep(0.2);
}}
"""
