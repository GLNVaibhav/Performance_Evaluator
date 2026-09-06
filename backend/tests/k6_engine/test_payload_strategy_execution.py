"""Session 3: REAL k6 subprocess execution proving TestPlan.payload_strategy
actually changes the request BODY BYTES k6 sends to the target -- not just
that the generated script.js *looks* right. Same stub-server pattern as
test_auth_propagation_execution.py (Session 2.5), capturing bodies instead
of headers this time.
"""
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.schemas.enums import PayloadStrategy
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.engine import RealK6PerformanceEngine

K6_BINARY = "/c/Program Files/k6/k6.exe" if Path("/c/Program Files/k6/k6.exe").exists() else "k6"

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)

_OPENAPI_DOC = json.dumps(
    {
        "paths": {
            "/cart": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "product_id": {"type": "integer", "maximum": 9999},
                                        "note": {"type": "string", "maxLength": 12},
                                    },
                                    "required": ["product_id"],
                                }
                            }
                        }
                    }
                }
            }
        }
    }
).encode()


class _BodyCapturingHandler(BaseHTTPRequestHandler):
    captured: list = []

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(_OPENAPI_DOC)))
        self.end_headers()
        self.wfile.write(_OPENAPI_DOC)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        _BodyCapturingHandler.captured.append(json.loads(raw))
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture()
def body_capture_server():
    _BodyCapturingHandler.captured = []
    server = HTTPServer(("127.0.0.1", 0), _BodyCapturingHandler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", _BodyCapturingHandler.captured
    finally:
        server.shutdown()


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-payload-strategy-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _engine(monkeypatch):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    return RealK6PerformanceEngine()


def _plan(strategy: PayloadStrategy) -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=5000, error_rate=1.0),
        selected_endpoints=["/cart"],
        target_vus=2,
        duration="3s",
        payload_strategy=strategy,
    )


def test_normal_strategy_sends_the_unchanged_default_body(monkeypatch, body_capture_server, artifact_dir):
    base_url, captured = body_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url)

    outcome = engine.execute(_plan(PayloadStrategy.normal), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert captured
    assert all(body.get("product_id") == 1 for body in captured)


def test_boundary_strategy_actually_sends_schema_declared_edge_values(monkeypatch, body_capture_server, artifact_dir):
    base_url, captured = body_capture_server
    engine = _engine(monkeypatch)
    target = TargetConfig(base_url=base_url)

    outcome = engine.execute(_plan(PayloadStrategy.boundary), target, artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert captured
    assert all(body.get("product_id") == 9999 for body in captured)
    assert all(body.get("note") == "x" * 12 for body in captured)
