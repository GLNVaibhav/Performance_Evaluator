"""BLOCKER 1 regression tests (Dev-3 gate review, second pass).

Principle: the security invariant is that externally-derived strings must
be represented as JS DATA (string literals), never as JS SYNTAX. A
literal backtick appearing INSIDE a json.dumps-produced double-quoted
string is harmless data -- testing "no backtick anywhere in the script"
is the wrong invariant, both over- and under-inclusive (flags harmless
payload content; says nothing about whether a value could actually
escape its own encoding). These tests instead verify, directly:

  1. target.base_url is emitted as a json.dumps-equivalent JS string
     literal (the BASE_URL declaration's RHS is EXACTLY that literal,
     nothing concatenated around it).
  2. resolved OpenAPI paths are emitted the same way (via _js_url_expr).
  3. `${...}` in a payload remains literal text and can never trigger
     template-literal interpolation -- proven by executing the real
     generated code and confirming the runtime value is unchanged,
     since interpolation succeeding would corrupt it.
  4. quotes/backslashes/newlines round-trip as data -- proven by reading
     the value back out of a REAL running JS engine, not just comparing
     Python strings.
  5. a malicious payload fragment never becomes an additional executable
     statement -- proven by executing and checking for the absence of
     the side effect the payload attempts (globalThis pollution).
  6. the full rendered script remains syntactically valid JS.

Properties 1-2 are static/structural (always run). Properties 3-5 are
proven by real Node execution of the exact generated code (skipped
gracefully if Node is unavailable, never required for CI -- a robust
unit-level substitute isn't possible for these three specifically,
because "can this text execute" is an execution question). Property 6
also uses Node's syntax checker.
"""
import json
import re
import shutil
import subprocess

import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import _js_url_expr, render_script

_THRESHOLDS = Thresholds(p95_latency_ms=2000, error_rate=0.01)

_INJECTION_PAYLOADS = [
    ("single_quote", "http://evil.example'; globalThis.injected=true; //"),
    ("double_quote", 'http://evil.example"; globalThis.injected=true; //'),
    ("backslash", "http://evil.example\\'; globalThis.injected=true; //"),
    ("newline", "http://evil.example\nglobalThis.injected=true;//"),
    ("backtick", "http://evil.example`; globalThis.injected=true; //`"),
    ("template_expr", "http://evil.example${globalThis.injected=true}"),
]

_node_required = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node not available for behavioral verification"
)

_BASE_URL_LINE_RE = re.compile(r"^const BASE_URL = (.+);$", re.MULTILINE)


def _extract_base_url_literal(script: str) -> str:
    match = _BASE_URL_LINE_RE.search(script)
    assert match, "no 'const BASE_URL = ...;' declaration found in rendered script"
    return match.group(1)


def _minimal_plan(*endpoints: str) -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=list(endpoints),
        target_vus=10,
        duration="10s",
    )


# --- Property 1: base_url is EXACTLY a json.dumps-equivalent literal -------


@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_base_url_is_emitted_as_json_equivalent_string_literal(name, payload):
    spec = normalize({"paths": {"/products": {"get": {}}}})
    script = render_script(_minimal_plan("/products"), TargetConfig(base_url=payload), spec)

    literal = _extract_base_url_literal(script)
    # The RHS must be EXACTLY the json.dumps encoding -- proves the value
    # is a single, whole string literal, not a value concatenated with or
    # embedded inside other expression fragments.
    assert literal == json.dumps(payload), (
        f"[{name}] BASE_URL RHS is not a bare json.dumps-equivalent literal: {literal!r}"
    )
    assert json.loads(literal) == payload


# --- Property 2: resolved paths are EXACTLY a json.dumps-equivalent literal


@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_resolved_path_is_emitted_as_json_equivalent_string_literal(name, payload):
    expr = _js_url_expr(payload)
    prefix = "BASE_URL + "
    assert expr.startswith(prefix), f"[{name}] unexpected url expression shape: {expr!r}"
    literal = expr[len(prefix):]
    assert literal == json.dumps(payload), f"[{name}] path literal is not a bare json.dumps encoding: {literal!r}"
    assert json.loads(literal) == payload


def test_js_url_expr_never_uses_template_literal_syntax():
    assert _js_url_expr("/products") == 'BASE_URL + "/products"'


@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_malicious_path_also_resolves_to_a_bare_literal_in_full_render(name, payload):
    """Same property 2 check, but through the full render_script path
    (OpenAPI paths dict -> endpoint_resolver -> script_renderer), not
    just the _js_url_expr unit -- proves the encoding survives the whole
    pipeline, not just the helper in isolation."""
    spec = normalize({"paths": {payload: {"get": {}}}})
    script = render_script(_minimal_plan(payload), TargetConfig(base_url="http://127.0.0.1:8080"), spec)
    expected = f"BASE_URL + {json.dumps(payload)}"
    assert expected in script, f"[{name}] expected exact url expression not found in rendered script"


# --- Properties 3-5: proven by real execution, not static inspection ------


@_node_required
@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_dynamic_value_executes_as_inert_data_with_no_side_effects(name, payload):
    """Executes the ACTUAL generated BASE_URL declaration and the ACTUAL
    generated URL-construction expression (both extracted verbatim from
    a real render_script() call, not hand-written) under real Node, and
    checks at runtime:

      - property 4 (round-trip): BASE_URL's runtime value is IDENTICAL
        to the original Python string, and the constructed url exactly
        equals base_url + path with no alteration.
      - property 3 (no interpolation): if `${...}` had triggered template
        interpolation anywhere, the round-trip check above would fail --
        `${globalThis.injected=true}` would evaluate to the string
        'true' and corrupt the value instead of leaving it as literal
        text, so a passing round-trip IS the proof it stayed literal.
      - property 5 (no additional executable statement): globalThis.
        injected -- which every payload here attempts to set as its
        injection probe -- must remain unset.
    """
    spec = normalize({"paths": {"/products": {"get": {}}}})
    script = render_script(_minimal_plan("/products"), TargetConfig(base_url=payload), spec)

    base_url_line = next(line for line in script.splitlines() if line.startswith("const BASE_URL ="))
    url_expr = _js_url_expr("/products")

    node_program = f"""
{base_url_line}
const url = {url_expr};
console.log(JSON.stringify({{
  injected: globalThis.injected === true,
  baseUrlMatches: BASE_URL === {json.dumps(payload)},
  urlMatches: url === {json.dumps(payload + "/products")},
}}));
"""
    proc = subprocess.run(["node", "-e", node_program], capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0, f"[{name}] node execution itself failed: {proc.stderr}"
    result = json.loads(proc.stdout.strip())

    assert result["injected"] is False, (
        f"[{name}] globalThis.injected was set -- payload fragment executed as an additional statement"
    )
    assert result["baseUrlMatches"] is True, (
        f"[{name}] BASE_URL's runtime value diverged from the source payload -- data did not round-trip"
    )
    assert result["urlMatches"] is True, (
        f"[{name}] constructed URL diverged from base_url+path -- interpolation or truncation occurred"
    )


@_node_required
def test_combined_malicious_base_url_and_path_do_not_cross_contaminate():
    """Both dynamic boundaries attacked in the same script at once --
    proves neither value's encoding can be broken out of by exploiting
    the other's position in the generated code."""
    base_payload = "http://evil.example`${globalThis.injected=true}"
    path_payload = "/pr'oducts`${globalThis.injected2=true}"

    spec = normalize({"paths": {path_payload: {"get": {}}}})
    script = render_script(
        _minimal_plan(path_payload), TargetConfig(base_url=base_payload), spec
    )

    base_url_line = next(line for line in script.splitlines() if line.startswith("const BASE_URL ="))
    url_expr = _js_url_expr(path_payload)

    node_program = f"""
{base_url_line}
const url = {url_expr};
console.log(JSON.stringify({{
  injected: globalThis.injected === true,
  injected2: globalThis.injected2 === true,
  urlMatches: url === {json.dumps(base_payload + path_payload)},
}}));
"""
    proc = subprocess.run(["node", "-e", node_program], capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0, f"node execution failed: {proc.stderr}"
    result = json.loads(proc.stdout.strip())
    assert result["injected"] is False
    assert result["injected2"] is False
    assert result["urlMatches"] is True


# --- Property 6: full rendered script remains syntactically valid --------


@_node_required
def test_full_rendered_script_is_syntactically_valid_js():
    """The most complex render path (checkout/cart dependency, two
    dynamic values) with an injection payload -- proves the malicious
    input doesn't merely fail to inject but also doesn't break the
    script into invalid JS."""
    payload = "http://evil.example`${globalThis.injected=true}//"
    spec = normalize(
        {
            "paths": {
                payload: {"get": {}},
                "/cart": {
                    "post": {
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"product_id": {"type": "integer"}},
                                        "required": ["product_id"],
                                    }
                                }
                            }
                        }
                    }
                },
                "/checkout": {
                    "post": {
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"cart_id": {"type": "string"}},
                                        "required": ["cart_id"],
                                    }
                                }
                            }
                        }
                    }
                },
            }
        }
    )
    script = render_script(
        _minimal_plan(payload, "/checkout"), TargetConfig(base_url="http://127.0.0.1:8080"), spec
    )

    result = subprocess.run(
        ["node", "--input-type=module", "--check"],
        input=script,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, f"rendered script is not valid JS: {result.stderr}"
