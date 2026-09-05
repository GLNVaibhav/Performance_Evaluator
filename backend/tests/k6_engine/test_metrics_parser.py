import json
from pathlib import Path

import pytest

from app.services.k6_engine.metrics_parser import MetricsParseError, parse_results
from app.services.k6_engine.script_renderer import EndpointTagInfo

FIXTURES = Path(__file__).parent / "fixtures"


def test_real_pass_fixture_parses_correctly():
    # Captured from an actual k6 run against the demo API in 'normal' mode.
    metrics = parse_results(FIXTURES / "real_pass_results.json", duration_s=5.0)
    assert metrics.error_rate == 0.0
    assert metrics.total_requests == 115
    assert metrics.failed_requests == 0
    assert metrics.p95_ms == pytest.approx(0.9647926999999998)
    assert metrics.p99_ms == pytest.approx(1.16087706)


def test_real_fail_fixture_parses_correctly():
    # Captured from an actual k6 run against the demo API in
    # 'error_injection' mode (configured ~30% failure rate).
    metrics = parse_results(FIXTURES / "real_fail_results.json", duration_s=5.0)
    assert metrics.error_rate == pytest.approx(0.30434782608695654)
    assert metrics.total_requests == 115
    assert metrics.failed_requests == round(0.30434782608695654 * 115)


def test_missing_p99_raises_execution_error_not_a_default_value():
    with pytest.raises(MetricsParseError):
        parse_results(FIXTURES / "missing_p99_results.json", duration_s=5.0)


def test_malformed_json_raises_execution_error():
    with pytest.raises(MetricsParseError):
        parse_results(FIXTURES / "malformed_results.json", duration_s=5.0)


def test_empty_metrics_object_raises_execution_error():
    with pytest.raises(MetricsParseError):
        parse_results(FIXTURES / "empty_metrics_results.json", duration_s=5.0)


def test_missing_file_raises_execution_error():
    with pytest.raises(MetricsParseError):
        parse_results(FIXTURES / "does_not_exist.json", duration_s=5.0)


def test_nested_values_layout_also_supported():
    """Some k6 versions nest stats under a 'values' key instead of putting
    them directly on the metric object -- handle both defensively."""
    import json

    nested = json.loads((FIXTURES / "real_pass_results.json").read_text())
    for name in ("http_req_duration", "http_reqs", "http_req_failed"):
        nested["metrics"][name] = {"values": nested["metrics"][name]}
    nested_path = FIXTURES / "_nested_layout_tmp.json"
    nested_path.write_text(json.dumps(nested))
    try:
        metrics = parse_results(nested_path, duration_s=5.0)
        assert metrics.total_requests == 115
    finally:
        nested_path.unlink()


# --- Per-endpoint breakdown (endpoint mix + per-endpoint evidence) --------

_DURATION_STATS = {"p(50)": 10.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0}


def _multi_endpoint_results(tmp_path: Path) -> Path:
    """Two distinctly-different tagged endpoints in one results.json, to
    prove metrics_parser doesn't cross-contaminate them."""
    data = {
        "metrics": {
            "http_req_duration": _DURATION_STATS,
            "http_reqs": {"count": 180, "rate": 22.5},
            "http_req_failed": {"value": 0.1},
            "http_req_duration{endpoint:endpoint_0}": {
                "p(50)": 5.0, "p(95)": 10.0, "p(99)": 15.0, "avg": 6.0, "max": 20.0,
            },
            "http_reqs{endpoint:endpoint_0}": {"count": 120, "rate": 15.0},
            "http_req_failed{endpoint:endpoint_0}": {"passes": 6, "fails": 114, "value": 0.05},
            "http_req_duration{endpoint:endpoint_1}": {
                "p(50)": 50.0, "p(95)": 4200.0, "p(99)": 5000.0, "avg": 2000.0, "max": 6000.0,
            },
            "http_reqs{endpoint:endpoint_1}": {"count": 60, "rate": 7.5},
            "http_req_failed{endpoint:endpoint_1}": {"passes": 30, "fails": 30, "value": 0.5},
        }
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data))
    return path


def test_multiple_tagged_endpoints_are_parsed_and_kept_separate(tmp_path):
    tags = [
        EndpointTagInfo(alias="endpoint_0", endpoint="/products", method="GET"),
        EndpointTagInfo(alias="endpoint_1", endpoint="/checkout", method="POST"),
    ]
    metrics = parse_results(_multi_endpoint_results(tmp_path), duration_s=8.0, endpoint_tags=tags)

    assert len(metrics.per_endpoint) == 2
    products = next(e for e in metrics.per_endpoint if e.endpoint == "/products")
    checkout = next(e for e in metrics.per_endpoint if e.endpoint == "/checkout")

    # Each endpoint's own numbers, not swapped or averaged together.
    assert products.total_requests == 120
    assert products.p95_ms == 10.0
    assert products.error_rate == 0.05
    assert products.failed_requests == 6  # from "passes", not "fails" (114)

    assert checkout.total_requests == 60
    assert checkout.p95_ms == 4200.0
    assert checkout.error_rate == 0.5
    assert checkout.failed_requests == 30

    # Per-endpoint parsing never touches (or corrupts) the aggregate.
    assert metrics.total_requests == 180
    assert metrics.error_rate == 0.1


def test_endpoint_with_no_recorded_requests_is_omitted_not_fabricated(tmp_path):
    """A configured endpoint that received zero traffic in this run (e.g.
    a very short run with a very small weight) must not appear with
    fabricated zero metrics -- it's simply absent, per module docstring."""
    tags = [
        EndpointTagInfo(alias="endpoint_0", endpoint="/products", method="GET"),
        EndpointTagInfo(alias="endpoint_2", endpoint="/rarely_hit", method="GET"),
    ]
    metrics = parse_results(_multi_endpoint_results(tmp_path), duration_s=8.0, endpoint_tags=tags)

    endpoints_seen = {e.endpoint for e in metrics.per_endpoint}
    assert "/products" in endpoints_seen
    assert "/rarely_hit" not in endpoints_seen


def test_malformed_single_endpoint_tag_does_not_fail_the_whole_run(tmp_path):
    """Per-endpoint enrichment is best-effort: garbage in the tagged
    submetric must not raise MetricsParseError for the whole (otherwise
    valid) run."""
    data = {
        "metrics": {
            "http_req_duration": _DURATION_STATS,
            "http_reqs": {"count": 10, "rate": 1.25},
            "http_req_failed": {"value": 0.0},
            "http_req_duration{endpoint:endpoint_0}": "not-a-dict",
            "http_reqs{endpoint:endpoint_0}": {"count": 10, "rate": 1.25},
            "http_req_failed{endpoint:endpoint_0}": {"value": 0.0},
        }
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data))

    metrics = parse_results(path, duration_s=8.0, endpoint_tags=[EndpointTagInfo("endpoint_0", "/broken", "GET")])
    assert metrics.per_endpoint == []
    assert metrics.total_requests == 10  # aggregate is unaffected
