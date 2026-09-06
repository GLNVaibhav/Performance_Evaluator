"""Session 5: HTTP status-code evidence extraction
(metrics_parser.py::_extract_status_codes / parse_results's status_codes
field). Uses realistic k6 results.json shapes -- including the project's
own pre-existing REAL captured fixtures (tests/k6_engine/fixtures/*.json),
which predate this mechanism and must degrade to `{}`, never an error.
"""
import json
from pathlib import Path

import pytest

from app.services.k6_engine.metrics_parser import MetricsParseError, _extract_status_codes, parse_results

_FIXTURES = Path(__file__).parent / "fixtures"


def _write(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data))
    return path


def _base_metrics(**overrides) -> dict:
    metrics = {
        "http_req_duration": {"p(50)": 10.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0},
        "http_reqs": {"count": 100, "rate": 10.0},
        "http_req_failed": {"value": 0.0, "rate": 0.0},
    }
    metrics.update(overrides)
    return metrics


# --- _extract_status_codes: unit-level -------------------------------------


def test_extracts_only_http_status_prefixed_checks():
    data = {
        "root_group": {
            "checks": {
                "http_status_200": {"passes": 950, "fails": 0},
                "http_status_404": {"passes": 30, "fails": 0},
                "http_status_500": {"passes": 20, "fails": 0},
                "status is not zero (request completed)": {"passes": 1000, "fails": 0},
                "checkout: got a response": {"passes": 44, "fails": 0},
            }
        }
    }
    assert _extract_status_codes(data) == {"200": 950, "404": 30, "500": 20}


def test_status_zero_is_recorded_as_a_real_no_response_code():
    """k6's own convention for a request that got no response at all
    (e.g. connection refused) -- real evidence of a failure mode, not a
    fabricated status."""
    data = {"root_group": {"checks": {"http_status_0": {"passes": 5, "fails": 0}}}}
    assert _extract_status_codes(data) == {"0": 5}


def test_no_root_group_returns_empty_dict_not_an_error():
    assert _extract_status_codes({}) == {}


def test_no_checks_returns_empty_dict():
    assert _extract_status_codes({"root_group": {}}) == {}


def test_checks_present_but_no_http_status_entries_returns_empty_dict():
    data = {"root_group": {"checks": {"status is not zero (request completed)": {"passes": 10, "fails": 0}}}}
    assert _extract_status_codes(data) == {}


def test_zero_pass_count_is_omitted_never_a_fabricated_zero_entry():
    data = {"root_group": {"checks": {"http_status_200": {"passes": 0, "fails": 0}}}}
    assert _extract_status_codes(data) == {}


# --- parse_results integration ----------------------------------------------


def test_parse_results_includes_status_codes_when_present(tmp_path):
    data = _base_metrics()
    full = {
        "metrics": data,
        "root_group": {
            "checks": {"http_status_200": {"passes": 95, "fails": 0}, "http_status_500": {"passes": 5, "fails": 0}}
        },
    }
    results_path = _write(tmp_path, full)
    metrics = parse_results(results_path, duration_s=10.0)
    assert metrics.status_codes == {"200": 95, "500": 5}


def test_parse_results_status_codes_empty_when_absent(tmp_path):
    full = {"metrics": _base_metrics(), "root_group": {"checks": {}}}
    results_path = _write(tmp_path, full)
    metrics = parse_results(results_path, duration_s=10.0)
    assert metrics.status_codes == {}


def test_real_pre_existing_fixtures_have_no_status_codes_but_still_parse(tmp_path):
    """These REAL captured k6 fixtures predate the status-code mechanism
    entirely -- parse_results must still succeed, with status_codes empty,
    never raising because a newer optional field's evidence is missing."""
    for fixture_name in ("real_pass_results.json", "real_fail_results.json", "missing_p99_results.json"):
        fixture = _FIXTURES / fixture_name
        if fixture_name == "missing_p99_results.json":
            with pytest.raises(MetricsParseError):
                parse_results(fixture, duration_s=5.0)
            continue
        metrics = parse_results(fixture, duration_s=5.0)
        assert metrics.status_codes == {}
