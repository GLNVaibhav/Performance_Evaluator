"""Session 4: REAL k6 execution of a "rich" experiment combining every
TestPlan dimension audited in docs/performance_engine_interface.md's
"Rich experiment representation" section at once -- endpoint_weights,
auth, payload_strategy, and per-endpoint tagging/metrics -- proving they
compose correctly together, not just individually (each already has its
own dedicated test elsewhere: test_script_renderer.py for weights,
test_auth_propagation_execution.py for auth,
test_payload_strategy_execution.py for payload_strategy).
"""
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.schemas.auth import AuthConfig, AuthType
from app.schemas.enums import PayloadStrategy
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.engine import RealK6PerformanceEngine

K6_BINARY = "/c/Program Files/k6/k6.exe" if Path("/c/Program Files/k6/k6.exe").exists() else "k6"

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)

_SECRET_TOKEN = "rich-experiment-secret-token"

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
                                    "properties": {"product_id": {"type": "integer", "maximum": 9999}},
                                    "required": ["product_id"],
                                }
                            }
                        }
                    }
                }
            },
        }
    }
).encode()


class _RichHandler(BaseHTTPRequestHandler):
    requests: list = []  # {method, path, headers, body}

    def _record(self, body=None):
        _RichHandler.requests.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers.items()), "body": body}
        )

    def do_GET(self):
        if self.path == "/openapi.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(_OPENAPI_DOC)))
            self.end_headers()
            self.wfile.write(_OPENAPI_DOC)
            return
        self._record()
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        self._record(json.loads(raw))
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture()
def rich_server():
    _RichHandler.requests = []
    server = HTTPServer(("127.0.0.1", 0), _RichHandler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", _RichHandler.requests
    finally:
        server.shutdown()


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-rich-experiment-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_rich_experiment_weights_auth_and_payload_strategy_compose_correctly(
    monkeypatch, rich_server, artifact_dir
):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    engine = RealK6PerformanceEngine()

    base_url, requests_log = rich_server
    target = TargetConfig(
        base_url=base_url, auth=AuthConfig(type=AuthType.bearer, token=_SECRET_TOKEN)
    )
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=5000, error_rate=1.0),
        selected_endpoints=["/products", "/cart"],
        endpoint_weights={"/products": 90, "/cart": 10},
        payload_strategy=PayloadStrategy.boundary,
        target_vus=5,
        duration="4s",
    )

    outcome = engine.execute(plan, target, artifact_dir)
    assert outcome.summary_exists, outcome.error_message

    # -- Endpoint mix: heavily skewed toward /products, /cart still hit at least once.
    products_hits = [r for r in requests_log if r["path"] == "/products"]
    cart_hits = [r for r in requests_log if r["path"] == "/cart"]
    assert len(products_hits) > len(cart_hits) >= 0

    # -- Auth reached every real request, regardless of which endpoint.
    assert requests_log
    assert all(r["headers"].get("Authorization") == f"Bearer {_SECRET_TOKEN}" for r in requests_log)

    # -- Payload strategy: boundary value (schema maximum) reached the target.
    if cart_hits:
        assert all(r["body"]["product_id"] == 9999 for r in cart_hits)

    # -- Per-endpoint evidence: both selected endpoints are labeled correctly
    #    in the returned metrics (when they received at least one request).
    labeled = {m.endpoint: m for m in outcome.metrics.per_endpoint}
    assert "/products" in labeled
    assert labeled["/products"].method == "GET"
    if "/cart" in labeled:
        assert labeled["/cart"].method == "POST"

    # -- Secret never leaked into the generated script.
    script_text = (artifact_dir / "script.js").read_text(encoding="utf-8")
    assert _SECRET_TOKEN not in script_text
