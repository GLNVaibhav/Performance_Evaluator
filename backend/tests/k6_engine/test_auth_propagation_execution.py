"""Session 2.5: REAL k6 subprocess execution proving TargetConfig.auth
actually reaches k6's real HTTP requests to the target -- not just that
the generated script.js *looks* right.

No mocks for the k6 process itself, same discipline as
test_real_k6_integration.py. Uses a tiny stdlib http.server target
(the same established pattern test_engine_exit_semantics.py already uses
for its native-threshold test) rather than the canonical demo API,
because the demo API has no endpoint that echoes received headers back --
this is test infrastructure, not a new demo application.
"""
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.schemas.auth import AuthConfig, AuthType
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.engine import RealK6PerformanceEngine

K6_BINARY = "/c/Program Files/k6/k6.exe" if Path("/c/Program Files/k6/k6.exe").exists() else "k6"

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)

_SECRET_TOKEN = "auth-propagation-secret-abc123"
_SECRET_API_KEY = "auth-propagation-apikey-def456"

_OPENAPI_DOC = json.dumps(
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
).encode()


class _HeaderCapturingHandler(BaseHTTPRequestHandler):
    """Serves /openapi.json statically; every OTHER request's headers are
    recorded (class-level, shared across the handful of requests one short
    k6 run makes) so the test can assert on what k6 actually sent."""

    captured: list = []  # reset per-test via fixture

    def _serve_openapi(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(_OPENAPI_DOC)))
        self.end_headers()
        self.wfile.write(_OPENAPI_DOC)

    def _capture_and_ok(self):
        _HeaderCapturingHandler.captured.append(dict(self.headers.items()))
        body = b'{"cart_id": "cart-1", "items": [], "total": 0.0}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/openapi.json":
            self._serve_openapi()
        else:
            self._capture_and_ok()

    def do_POST(self):
        # drain the body so the client doesn't see a broken pipe
        length = int(self.headers.get("Content-Length", 0))
        if length:
            self.rfile.read(length)
        self._capture_and_ok()

    def log_message(self, *a):
        pass


@pytest.fixture()
def header_capture_server():
    _HeaderCapturingHandler.captured = []
    server = HTTPServer(("127.0.0.1", 0), _HeaderCapturingHandler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", _HeaderCapturingHandler.captured
    finally:
        server.shutdown()


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-auth-propagation-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _engine(monkeypatch):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    return RealK6PerformanceEngine()


def _tiny_plan(*endpoints):
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=5000, error_rate=1.0),
        selected_endpoints=list(endpoints),
        target_vus=2,
        duration="3s",
    )


# --- A: bearer auth reaches real k6 requests -------------------------------


def test_bearer_auth_header_actually_reaches_the_target_via_real_k6(monkeypatch, header_capture_server, artifact_dir):
    base_url, captured = header_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url, auth=AuthConfig(type=AuthType.bearer, token=_SECRET_TOKEN))

    outcome = engine.execute(_tiny_plan("/products"), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert captured, "target never received any request"
    assert any(h.get("Authorization") == f"Bearer {_SECRET_TOKEN}" for h in captured), captured


# --- B: api_key_header auth reaches real k6 requests -----------------------


def test_api_key_header_auth_actually_reaches_the_target_via_real_k6(monkeypatch, header_capture_server, artifact_dir):
    base_url, captured = header_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(
        base_url=base_url,
        auth=AuthConfig(type=AuthType.api_key_header, header_name="X-API-Key", api_key=_SECRET_API_KEY),
    )

    outcome = engine.execute(_tiny_plan("/products"), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert any(h.get("X-Api-Key") == _SECRET_API_KEY for h in captured), captured


# --- C: no-auth runs behave exactly as before ------------------------------


def test_no_auth_run_still_completes_and_sends_no_extra_auth_header(monkeypatch, header_capture_server, artifact_dir):
    base_url, captured = header_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url)  # no auth at all -- backward-compat path

    outcome = engine.execute(_tiny_plan("/products"), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert captured
    for h in captured:
        assert "Authorization" not in h
        assert "X-Api-Key" not in h


# --- E: raw secret never appears in generated artifacts --------------------


def test_secret_never_appears_in_script_or_result_artifacts(monkeypatch, header_capture_server, artifact_dir):
    base_url, captured = header_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url, auth=AuthConfig(type=AuthType.bearer, token=_SECRET_TOKEN))

    outcome = engine.execute(_tiny_plan("/products"), target, artifact_dir)
    assert outcome.summary_exists, outcome.error_message

    # Confirm the secret really did reach the target (otherwise this test
    # would trivially "pass" for the wrong reason).
    assert any(h.get("Authorization") == f"Bearer {_SECRET_TOKEN}" for h in captured)

    for name in ("script.js", "results.json", "stdout.log", "stderr.log"):
        path = artifact_dir / name
        if path.exists():
            content = path.read_text(encoding="utf-8", errors="replace")
            assert _SECRET_TOKEN not in content, f"secret leaked into {name}"
    # And the fixed env-var NAME (never the value) is exactly what's there.
    script_text = (artifact_dir / "script.js").read_text(encoding="utf-8")
    assert "PERF_EVAL_AUTH_HEADER_NAME" in script_text
    assert "PERF_EVAL_AUTH_HEADER_VALUE" in script_text
    assert _SECRET_TOKEN not in script_text


# --- H: /checkout -> /cart dependency also receives auth -------------------


def test_checkout_cart_dependency_both_receive_auth(monkeypatch, header_capture_server, artifact_dir):
    base_url, captured = header_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url, auth=AuthConfig(type=AuthType.bearer, token=_SECRET_TOKEN))

    outcome = engine.execute(_tiny_plan("/checkout"), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    # Both the auto-generated /cart call and the /checkout call itself must
    # have carried the header -- at least two authenticated POSTs recorded.
    authed = [h for h in captured if h.get("Authorization") == f"Bearer {_SECRET_TOKEN}"]
    assert len(authed) >= 2, captured
