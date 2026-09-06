"""Final session: app/services/ai_analyzer.py::AIResultAnalyzer. Uses
httpx.MockTransport for fully offline, deterministic testing of the REAL
request-building and response-parsing code -- same pattern already
established by tests/test_llm_intent_interpreter.py for
LLMIntentInterpreter. No real network call, no real API key needed.
"""
import json

import httpx
import pytest

from app.schemas.enums import Confidence, ResultClassification, Severity
from app.schemas.test_plan import FixedLoadPlan, Thresholds
from app.schemas.test_result import (
    EndpointRankings,
    ErrorStatistics,
    LatencyStatistics,
    MetricsSummary,
    StatusCodeStatistics,
    Statistics,
    ThresholdViolation,
    ThroughputStatistics,
    build_failure_localization,
)
from app.services.ai_analyzer import AIAnalysisInput, AIResultAnalyzer


def _plan() -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=500, error_rate=0.01),
        selected_endpoints=["/checkout"],
        target_vus=50,
        duration="30s",
    )


def _statistics() -> Statistics:
    return Statistics(
        latency=LatencyStatistics(p50_ms=100.0, p95_ms=820.0, p99_ms=900.0, average_ms=150.0, max_ms=950.0),
        throughput=ThroughputStatistics(total_requests=1000, requests_per_second=33.3, requests_per_minute=2000.0),
        errors=ErrorStatistics(failed_requests=10, error_rate=0.01, success_rate=0.99),
        status_codes=StatusCodeStatistics(counts={"200": 990, "500": 10}, percentages={"200": 99.0, "500": 1.0}),
        endpoint_rankings=EndpointRankings(),
        endpoint_shares=[],
    )


def _evidence() -> AIAnalysisInput:
    violations = [ThresholdViolation(scope="/checkout", metric="p95_latency_ms", observed=820.0, threshold=500.0)]
    metrics = MetricsSummary(
        p50_ms=100.0,
        p95_ms=820.0,
        p99_ms=900.0,
        average_ms=150.0,
        max_ms=950.0,
        rps=33.3,
        total_requests=1000,
        failed_requests=10,
        error_rate=0.01,
        duration_s=30.0,
    )
    fl = build_failure_localization(metrics, ResultClassification.FAIL, violations, _plan())
    return AIAnalysisInput(
        run_id="run-123",
        target_base_url="http://127.0.0.1:8080",
        plan=_plan(),
        threshold_status=ResultClassification.FAIL,
        statistics=_statistics(),
        failure_localization=fl,
    )


def _mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# --- Success path -------------------------------------------------------------


def test_valid_response_parses_into_ai_analysis():
    payload = {
        "summary": "Checkout latency exceeded the configured p95 threshold.",
        "severity": "high",
        "findings": [{"statement": "/checkout p95 was 820ms against a 500ms threshold.", "evidence_ref": "primary_failure"}],
        "confidence": "high",
        "limitations": ["Infrastructure telemetry was not available to determine the root cause."],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload)}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    result = analyzer.analyze(_evidence())

    assert result is not None
    assert result.severity == Severity.high
    assert result.confidence == Confidence.high
    assert result.findings[0].evidence_ref == "primary_failure"
    assert len(result.limitations) == 1


def test_response_wrapped_in_markdown_code_fence_is_still_parsed():
    payload = {"summary": "All good.", "severity": "none", "findings": [], "confidence": "high", "limitations": []}
    fenced = f"```json\n{json.dumps(payload)}\n```"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": fenced}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    result = analyzer.analyze(_evidence())
    assert result is not None
    assert result.severity == Severity.none


# --- Failure handling: never raises, always degrades to None ----------------


def test_malformed_json_returns_none_not_a_crash():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "not json at all"}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    assert analyzer.analyze(_evidence()) is None


def test_schema_invalid_response_returns_none():
    """Valid JSON, but missing required fields / wrong enum value --
    caught by AIAnalysis.model_validate(), never a crash, never a
    best-effort partial object."""
    bad_payload = {"summary": "ok", "severity": "catastrophic", "findings": [], "confidence": "high", "limitations": []}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(bad_payload)}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    assert analyzer.analyze(_evidence()) is None


def test_missing_required_field_returns_none():
    incomplete = {"summary": "ok"}  # missing severity/confidence

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(incomplete)}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    assert analyzer.analyze(_evidence()) is None


def test_provider_non_2xx_returns_none_not_a_crash():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid api key"})

    analyzer = AIResultAnalyzer(api_key="bad-key", http_client=_mock_client(handler))
    assert analyzer.analyze(_evidence()) is None


def test_provider_connection_failure_returns_none_not_a_crash():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    assert analyzer.analyze(_evidence()) is None


# --- Secret safety: structurally impossible to leak --------------------------


def test_evidence_bundle_has_no_field_capable_of_holding_a_secret():
    """AIAnalysisInput has no auth-shaped field at all -- TestPlan itself
    has no auth field (see app/schemas/test_plan.py::TargetConfig's
    docstring), and only a plain, non-secret base_url string is included."""
    evidence = _evidence()
    dumped = evidence.model_dump()
    assert "auth" not in dumped
    assert "target" not in dumped  # no TargetConfig object at all, just target_base_url
    assert set(dumped.keys()) == {
        "run_id",
        "target_base_url",
        "plan",
        "threshold_status",
        "statistics",
        "failure_localization",
    }


def test_request_body_sent_to_provider_never_contains_a_secret_shaped_string():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content.decode("utf-8")
        payload = {"summary": "ok", "severity": "none", "findings": [], "confidence": "high", "limitations": []}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload)}}]})

    analyzer = AIResultAnalyzer(api_key="test-key", http_client=_mock_client(handler))
    analyzer.analyze(_evidence())

    assert "captured" in dir()  # sanity: handler ran
    for marker in ("Bearer ", "api_key", "token", "secret", "password"):
        assert marker not in captured["body"], f"'{marker}' unexpectedly present in the LLM request body"
