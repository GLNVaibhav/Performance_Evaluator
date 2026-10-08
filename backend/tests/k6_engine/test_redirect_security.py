"""Redirect-security regression tests (audit finding 1).

The invariant under test:

    UNVALIDATED REDIRECT DESTINATION -> MUST NOT become a k6 load target.

k6 follows HTTP redirects by default; before this fix the rendered script
emitted bare `http.get(...)`/`http.post(...)` calls with no redirect
configuration at all, so an authorized target could 302 the ACTUAL load
phase to a destination the application's SSRF policy never approved (the
policy only guarded probe/OpenAPI fetches). The fix (script_renderer.py)
pins `redirects: 0` on every request and re-validates every 3xx hop with
the same policy classes as app/services/target_url_safety.py and the same
hop limit as src/convex/probe.ts (MAX_REDIRECTS = 3).

Coverage (per the remediation brief):
  A.  allowed redirect  -> followed, execution completes (REAL k6, local server)
  A2. allowed redirect to a different, policy-validating destination -> followed
  B.  blocked redirect  -> the blocked destination receives ZERO requests
      (both block classes: private under TARGET_SSRF_POLICY=block_private,
      and a hostname the k6 runtime cannot statically validate)
  C.  multi-hop: exactly probe.ts's hop policy -- initial + 3 redirects,
      the 4th redirect never followed
  D.  no silent bypass: the rendered script pins `redirects: 0` on every
      request and routes every request through the validating wrapper

Execution tests run a REAL k6 subprocess (pinned binary: v0.57.0) against
local, controlled HTTP servers only. No public websites. No mocked security
boundary -- the blocked-destination assertions are observed hit counts on a
real second server that would receive traffic iff the guard failed.
"""
import json
import os
import re
import shutil
import tempfile
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.core.config import TARGET_SSRF_POLICY
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine import script_renderer as script_renderer_module
from app.services.k6_engine.engine import RealK6PerformanceEngine
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import render_script

K6_BINARY = os.environ.get("K6_BINARY", "k6")

requires_k6 = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)

_SPEC = normalize(
    {
        "paths": {
            "/products": {"get": {}},
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
_OPENAPI_BYTES = json.dumps(
    {
        "paths": {
            "/products": {"get": {}},
            "/cart": {"post": {}},
            "/checkout": {"post": {}},
        }
    }
).encode()
_JSON = {"Content-Type": "application/json"}

# Lenient-but-real thresholds: every assertion here is about redirect SAFETY,
# not performance. error_rate=1.0 makes the threshold outcome independent of
# how k6 classifies 3xx samples (PASS iff error_rate <= 1.0 -- see
# threshold_evaluator.py), so no test here can pass or fail for a reason
# unrelated to the security invariant.
_THRESHOLDS = Thresholds(p95_latency_ms=5000, error_rate=1.0)


# --- Render-level invariants (no k6 required) -------------------------------


def _plan(endpoint: str = "/products") -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=[endpoint],
        target_vus=2,
        duration="4s",
    )


def test_no_silent_bypass_every_request_pins_redirects_zero_and_uses_the_wrapper():
    """Finding 1, requirement D: k6 cannot simply follow an unchecked
    redirect from the generated script."""
    target = TargetConfig(base_url="http://127.0.0.1:8080")
    for endpoint in ("/products", "/cart", "/checkout"):
        script = render_script(_plan(endpoint), target, _SPEC)

        # 1. The ONLY redirect configuration present is `redirects: 0`
        #    (the pattern also sees the wrapper's own comment mentioning
        #    `redirects: 0`, so strip backticks/whitespace before comparing).
        redirect_values = re.findall(r"redirects:\s*([^,}\n]+)", script)
        assert redirect_values, f"[{endpoint}] wrapper must pin redirects: 0"
        normalized = [value.strip().strip("`").strip() for value in redirect_values]
        assert all(value == "0" for value in normalized), normalized

        # 2. No direct k6 http.<method>(...) call exists anywhere in the
        #    script -- every request must go through the validating wrapper.
        assert re.findall(r"http\.\w+\(", script) == [], f"[{endpoint}] bare k6 http call found"
        assert "http[currentMethod](" in script  # the wrapper's single request mechanism

        # 3. The dispatch (and the checkout/cart special case) emit wrapper
        #    calls, never raw requests.
        assert "requestWithRedirectPolicy(" in script

    # GET dispatch for /products goes through the wrapper.
    script = render_script(_plan("/products"), target, _SPEC)
    assert script.count('requestWithRedirectPolicy("get"') == 1

    # The checkout special case routes BOTH its /cart and /checkout calls
    # through the wrapper.
    script = render_script(_plan("/checkout"), target, _SPEC)
    assert script.count('requestWithRedirectPolicy("post"') == 2


def test_rendered_script_embeds_the_application_ssrf_policy_classes():
    target = TargetConfig(base_url="http://127.0.0.1:8080")
    script = render_script(_plan(), target, _SPEC)

    # Hop policy identical to probe.ts (MAX_REDIRECTS = 3).
    assert "const MAX_REDIRECTS = 3;" in script

    # TARGET_SSRF_POLICY is embedded at render time (same policy classes as
    # target_url_safety.py: metadata always blocked, private per policy).
    expected_allow_private = "false" if TARGET_SSRF_POLICY == "block_private" else "true"
    assert f"const ALLOW_PRIVATE = {expected_allow_private};" in script
    for literal in ("169.254.169.254", "100.100.100.200", "metadata.google.internal"):
        assert literal in script

    # The authorized target host is embedded for the same-host rule.
    assert 'const TARGET_HOST = "127.0.0.1";' in script

    # The fail-closed rule (hostnames k6 cannot statically validate) exists.
    assert "redirect_blocked_unvalidated_host" in script
    assert "redirect_blocked_metadata_host" in script


def test_block_private_policy_is_embedded_when_configured(monkeypatch):
    monkeypatch.setattr(script_renderer_module, "TARGET_SSRF_POLICY", "block_private")
    script = render_script(_plan(), TargetConfig(base_url="http://127.0.0.1:8080"), _SPEC)
    assert "const ALLOW_PRIVATE = false;" in script


# --- Controlled local redirect servers --------------------------------------


def _redirect(location: str) -> tuple:
    return (302, {"Location": location}, b"")


class _ControlledServer:
    """Local HTTP server with a mutable route table (populated after both
    servers exist, so routes can reference each other's port) and per-path
    hit counts -- the observable evidence for 'was load ever sent there?'."""

    def __init__(self) -> None:
        self.routes: dict = {}
        self.hits: Counter = Counter()
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = self.path.split("?", 1)[0]
                with outer._lock:
                    outer.hits[path] += 1
                status, headers, body = outer.routes.get(path, (404, {}, b"not found"))
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-redirect-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _execute(base_url: str, artifact_dir: Path, monkeypatch):
    """The REAL execution path: RealK6PerformanceEngine.execute() ->
    render_script() -> run_k6 (real subprocess) -> results.json ->
    parse_results -> evaluate_threshold."""
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    engine = RealK6PerformanceEngine()
    plan = _plan()
    return engine.execute(plan, TargetConfig(base_url=base_url), artifact_dir)


def _check_names(artifact_dir: Path) -> set:
    data = json.loads((artifact_dir / "results.json").read_text())
    checks = data.get("root_group", {}).get("checks", {})
    assert isinstance(checks, dict)
    return set(checks.keys())


# --- A. allowed redirect -----------------------------------------------------


@requires_k6
def test_allowed_redirect_to_same_authorized_host_is_followed(monkeypatch, artifact_dir):
    target = _ControlledServer()
    try:
        target.routes["/openapi.json"] = (200, _JSON, _OPENAPI_BYTES)
        target.routes["/products"] = _redirect("/final")  # relative Location, same host
        target.routes["/final"] = (200, _JSON, b"{}")

        outcome = _execute(target.base_url, artifact_dir, monkeypatch)
        assert outcome.summary_exists, outcome.error_message
        assert outcome.metrics is not None
        assert outcome.metrics.total_requests > 0
        # The allowed destination actually received the measured load.
        assert target.hits["/products"] > 0
        assert target.hits["/final"] > 0
        # Both the intermediate hop and the final response were recorded.
        assert "302" in outcome.metrics.status_codes
        assert "200" in outcome.metrics.status_codes
        from app.schemas.enums import ResultClassification

        assert outcome.threshold_status == ResultClassification.PASS
        assert (artifact_dir / "results.json").exists()
    finally:
        target.stop()


@requires_k6
def test_allowed_redirect_to_a_different_policy_validating_destination_is_followed(monkeypatch, artifact_dir):
    """A redirect to a different destination that PASSES the SSRF policy
    (an IP literal -- statically validatable without DNS; loopback is
    allowed under the default TARGET_SSRF_POLICY=allow_private) is followed
    and that destination receives the load."""
    target = _ControlledServer()
    observer = _ControlledServer()
    try:
        target.routes["/openapi.json"] = (200, _JSON, _OPENAPI_BYTES)
        target.routes["/products"] = _redirect(f"{observer.base_url}/accepted")
        observer.routes["/accepted"] = (200, _JSON, b"{}")

        outcome = _execute(target.base_url, artifact_dir, monkeypatch)
        assert outcome.summary_exists, outcome.error_message
        assert outcome.metrics is not None
        assert observer.hits["/accepted"] > 0, "allowed destination never received load"
        assert "200" in outcome.metrics.status_codes
        assert (artifact_dir / "results.json").exists()
    finally:
        target.stop()
        observer.stop()


# --- B. blocked redirects ----------------------------------------------------


@requires_k6
def test_blocked_private_redirect_destination_receives_zero_load(monkeypatch, artifact_dir):
    """TARGET_SSRF_POLICY=block_private: a redirect to a private/loopback
    destination -- even one that is perfectly reachable -- must NOT be
    followed. The second server's hit count is the proof."""
    monkeypatch.setattr(script_renderer_module, "TARGET_SSRF_POLICY", "block_private")
    target = _ControlledServer()
    observer = _ControlledServer()
    try:
        target.routes["/openapi.json"] = (200, _JSON, _OPENAPI_BYTES)
        target.routes["/products"] = _redirect(f"{observer.base_url}/collect")

        outcome = _execute(target.base_url, artifact_dir, monkeypatch)
        assert outcome.summary_exists, outcome.error_message
        # ZERO load reached the blocked destination...
        assert observer.hits["/collect"] == 0, f"blocked destination received {observer.hits['/collect']} requests"
        # ...while the authorized target itself was exercised normally.
        assert target.hits["/products"] > 0
        # The unfollowed 3xx was measured honestly and the reason recorded.
        assert outcome.metrics is not None
        assert "302" in outcome.metrics.status_codes
        assert "redirect_blocked_private_host" in _check_names(artifact_dir)
        assert (artifact_dir / "results.json").exists()
    finally:
        target.stop()
        observer.stop()


@requires_k6
def test_redirect_to_hostname_k6_cannot_validate_is_refused(monkeypatch, artifact_dir):
    """Default policy: a redirect whose host is neither the authorized
    target host nor a statically validatable IP literal is refused
    (fail-closed -- k6 has no DNS API). The destination is a real, reachable
    local server; it must receive ZERO requests."""
    target = _ControlledServer()
    observer = _ControlledServer()
    try:
        target.routes["/openapi.json"] = (200, _JSON, _OPENAPI_BYTES)
        # base host is 127.0.0.1; 'localhost' is a different (unvalidatable)
        # hostname even though it resolves to the same machine.
        target.routes["/products"] = _redirect(f"http://localhost:{observer.port}/collect")

        outcome = _execute(target.base_url, artifact_dir, monkeypatch)
        assert outcome.summary_exists, outcome.error_message
        assert observer.hits["/collect"] == 0, f"unvalidated hostname destination received {observer.hits['/collect']} requests"
        assert target.hits["/products"] > 0
        assert outcome.metrics is not None
        assert "302" in outcome.metrics.status_codes
        assert "redirect_blocked_unvalidated_host" in _check_names(artifact_dir)
    finally:
        target.stop()
        observer.stop()


# --- C. multi-hop behavior ---------------------------------------------------


@requires_k6
def test_multi_hop_redirects_stop_after_three_hops_matching_probe_policy(monkeypatch, artifact_dir):
    """probe.ts policy: initial request + at most 3 redirect hops (4 fetches
    total), then stop. The 4th hop's destination (/h4) must receive ZERO
    requests even though it exists and would answer 200."""
    target = _ControlledServer()
    try:
        target.routes["/openapi.json"] = (200, _JSON, _OPENAPI_BYTES)
        target.routes["/products"] = _redirect("/h1")
        target.routes["/h1"] = _redirect("/h2")
        target.routes["/h2"] = _redirect("/h3")
        target.routes["/h3"] = _redirect("/h4")  # the 4th redirect -- must NOT be followed
        target.routes["/h4"] = (200, _JSON, b"{}")

        outcome = _execute(target.base_url, artifact_dir, monkeypatch)
        assert outcome.summary_exists, outcome.error_message
        assert outcome.metrics is not None

        hits = target.hits
        # Exactly probe.ts's hop policy: initial + 3 followed redirects...
        assert hits["/products"] > 0
        assert hits["/h3"] > 0, "the 3 allowed hops must be followed"
        # ...never the 4th redirect's destination.
        assert hits["/h4"] == 0, f"/h4 received {hits['/h4']} requests (4th redirect followed!)"
        # Monotonic non-increase along the chain (each hop requires the
        # previous one to have been answered with a redirect).
        assert hits["/products"] >= hits["/h1"] >= hits["/h2"] >= hits["/h3"] >= hits["/h4"]
        # Every hop was an honest302 observation; the stop reason is recorded.
        assert "302" in outcome.metrics.status_codes
        assert "redirect_not_followed_hop_limit" in _check_names(artifact_dir)
        assert (artifact_dir / "results.json").exists()
    finally:
        target.stop()
