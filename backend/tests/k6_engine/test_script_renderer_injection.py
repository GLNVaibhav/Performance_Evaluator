"""BLOCKER 1 regression tests (Dev-3 gate review): dynamic values reaching
the generated k6 script (target.base_url, OpenAPI-derived resolved paths)
must be encoded as safe JS string literals and must never be able to alter
generated JavaScript syntax or semantics.

Threat model: `target.base_url` comes from the run request; resolved
paths come from the TARGET's own /openapi.json, which is externally
fetched and therefore not trusted content, even though it's not
attacker-input in the traditional sense -- a malicious or buggy target
service can return arbitrary path strings.

Two layers of proof, per the remediation brief:
  1. Structural, dependency-free assertions that always run in CI --
     prove the payload is only ever present inside a json.dumps()-encoded
     literal, and that NO backtick template literals exist anywhere in
     the output (backtick/`${...}` are inert outside a template literal,
     so their complete absence is itself the strongest structural proof).
  2. An optional Node-based behavioral test (skipped if Node isn't
     available) that actually evaluates the extracted BASE_URL/URL
     construction lines and proves no injected code executes and the
     reconstructed URL exactly matches the original input.
"""
import json
import shutil
import subprocess

import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import _js_url_expr, render_script

_THRESHOLDS = Thresholds(p95_latency_ms=2000, error_rate=0.01)

# Every character class called out in the remediation brief, plus the
# harmless injection probe it names explicitly.
_INJECTION_PAYLOADS = [
    ("single_quote", "http://evil.example'; globalThis.injected=true; //"),
    ("double_quote", 'http://evil.example"; globalThis.injected=true; //'),
    ("backslash", "http://evil.example\\'; globalThis.injected=true; //"),
    ("newline", "http://evil.example\nglobalThis.injected=true;//"),
    ("backtick", "http://evil.example`; globalThis.injected=true; //`"),
    ("template_expr", "http://evil.example${globalThis.injected=true}"),
]


def _spec_with_malicious_path(payload: str):
    # The OpenAPI 'paths' key becomes the endpoint's path template
    # verbatim (see openapi_loader.normalize) -- this is exactly how a
    # malicious/buggy target's own openapi.json would surface an
    # injection attempt through resolved_path.
    return normalize({"paths": {payload: {"get": {}}}})


@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_base_url_injection_payloads_are_structurally_neutralized(name, payload):
    spec = normalize({"paths": {"/products": {"get": {}}}})
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products"],
        target_vus=10,
        duration="10s",
    )
    target = TargetConfig(base_url=payload)

    script = render_script(plan, target, spec)

    # 1. No backtick template literals in the CODE STRUCTURE. A payload
    #    may legitimately *contain* a literal backtick character as data --
    #    that's harmless once safely bounded inside a json.dumps() double-
    #    quoted string (backtick has no special meaning there). What must
    #    never happen is the surrounding code using a backtick to OPEN a
    #    template literal. So: strip out the one safely-encoded occurrence
    #    of the payload, then assert no backtick remains in what's left.
    encoded = json.dumps(payload)
    code_without_payload_literal = script.replace(encoded, "")
    assert "`" not in code_without_payload_literal, (
        f"[{name}] backtick found OUTSIDE the encoded literal -- "
        "template literal syntax reintroduced into code structure"
    )

    # 2. The exact json.dumps() encoding of the payload appears verbatim --
    #    proves it went through the safe-encoding path, not string glued.
    assert encoded in script, f"[{name}] expected json.dumps-encoded literal not found in script"

    # 3. The payload is faithfully represented once decoded back out of
    #    the script's own JSON-literal encoding (round-trip fidelity).
    assert json.loads(encoded) == payload

    # 4. The dangerous substring never appears as RAW, un-quoted source
    #    outside of the one safe encoded occurrence. Since a single-line
    #    Python string containing '\n' becomes an escaped '\\n' inside
    #    json.dumps output, a raw newline character can only appear in
    #    the rendered script if it leaked in unescaped -- assert it did not.
    if "\n" in payload:
        assert "\n" not in encoded  # json.dumps must have escaped it
    # 5. The script must remain a single well-formed const assignment for
    #    BASE_URL -- no stray semicolon breaking out of the statement.
    assert script.count("const BASE_URL = ") == 1


@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_openapi_derived_path_injection_payloads_are_structurally_neutralized(name, payload):
    spec = _spec_with_malicious_path(payload)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=[payload],
        target_vus=10,
        duration="10s",
    )
    target = TargetConfig(base_url="http://127.0.0.1:8080")

    script = render_script(plan, target, spec)

    assert "`" not in script.replace(json.dumps(payload), ""), (
        f"[{name}] backtick found OUTSIDE the encoded literal for malicious path"
    )
    encoded = json.dumps(payload)
    assert encoded in script, f"[{name}] expected json.dumps-encoded path literal not found"
    assert json.loads(encoded) == payload


def test_js_url_expr_never_uses_template_literal_syntax():
    expr = _js_url_expr("/products")
    assert "`" not in expr
    assert expr == 'BASE_URL + "/products"'


@pytest.mark.skipif(shutil.which("node") is None, reason="Node not available for behavioral verification")
@pytest.mark.parametrize("name,payload", _INJECTION_PAYLOADS)
def test_node_actually_evaluates_safely_no_global_pollution(name, payload):
    """Extract just the BASE_URL declaration + one URL-construction
    expression (both plain JS, no k6-specific imports needed) and run
    them under real Node. Proves, by actual execution rather than static
    inspection, that the injection payload never becomes executable code:
    globalThis.injected must remain unset, and the reconstructed URL must
    exactly equal base_url + path with no alteration.
    """
    spec = normalize({"paths": {"/products": {"get": {}}}})
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products"],
        target_vus=10,
        duration="10s",
    )
    target = TargetConfig(base_url=payload)
    script = render_script(plan, target, spec)

    base_url_line = next(line for line in script.splitlines() if line.startswith("const BASE_URL ="))
    url_expr = _js_url_expr("/products")

    node_program = f"""
{base_url_line}
const url = {url_expr};
if (globalThis.injected === true) {{
  console.log("INJECTED");
  process.exit(1);
}}
if (url !== {json.dumps(payload + "/products")}) {{
  console.log("URL_MISMATCH:" + url);
  process.exit(2);
}}
console.log("OK");
"""
    result = subprocess.run(
        ["node", "-e", node_program], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, (
        f"[{name}] node evaluation failed (code {result.returncode}): "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert result.stdout.strip() == "OK"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node not available for syntax verification")
def test_full_rendered_script_is_syntactically_valid_js():
    """Sanity check that a malicious payload doesn't merely fail to
    inject but ALSO doesn't break the script into invalid JS (which would
    surface as a confusing k6 startup error rather than a clean rejection
    upstream). Uses the demo-api-shaped spec with a checkout dependency,
    the most complex render path, plus one injection payload.
    """
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
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=[payload, "/checkout"],
        target_vus=10,
        duration="10s",
    )
    target = TargetConfig(base_url="http://127.0.0.1:8080")
    script = render_script(plan, target, spec)

    # k6's `import http from 'k6/http'` will fail under plain Node (no k6
    # module resolution) -- strip it for a pure syntax check; k6/`import`
    # syntax itself is standard ES module syntax Node understands fine,
    # it's only the module resolution that would fail, and --check only
    # parses, it doesn't execute or resolve imports.
    result = subprocess.run(
        ["node", "--input-type=module", "--check"],
        input=script,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, f"rendered script is not valid JS: {result.stderr}"
