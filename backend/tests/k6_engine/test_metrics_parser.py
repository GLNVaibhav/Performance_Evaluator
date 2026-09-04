from pathlib import Path

import pytest

from app.services.k6_engine.metrics_parser import MetricsParseError, parse_results

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
