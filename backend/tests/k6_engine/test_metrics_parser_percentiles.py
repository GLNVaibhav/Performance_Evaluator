"""Session 5: optional p75/p90 latency percentiles
(metrics_parser.py::parse_results). Additive -- p50/p95/p99 remain
required, unchanged; p75/p90 are the only NEW optional fields, absent
(never backfilled/estimated) when the underlying results.json didn't
collect them.
"""
import json
from pathlib import Path

from app.services.k6_engine.metrics_parser import parse_results


def _write(tmp_path: Path, duration_stats: dict) -> Path:
    data = {
        "metrics": {
            "http_req_duration": duration_stats,
            "http_reqs": {"count": 100, "rate": 10.0},
            "http_req_failed": {"value": 0.0, "rate": 0.0},
        }
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data))
    return path


def test_p75_and_p90_are_extracted_when_present(tmp_path):
    results_path = _write(
        tmp_path,
        {"p(50)": 10.0, "p(75)": 15.0, "p(90)": 18.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0},
    )
    metrics = parse_results(results_path, duration_s=10.0)
    assert metrics.p75_ms == 15.0
    assert metrics.p90_ms == 18.0


def test_p75_and_p90_are_none_when_absent_never_estimated(tmp_path):
    """The exact real, pre-existing k6 fixture shape (before k6_runner.py's
    expanded --summary-trend-stats) -- only min/med/avg/max/p50/p95/p99."""
    results_path = _write(
        tmp_path, {"p(50)": 10.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0}
    )
    metrics = parse_results(results_path, duration_s=10.0)
    assert metrics.p75_ms is None
    assert metrics.p90_ms is None
    # Required percentiles are completely unaffected.
    assert metrics.p50_ms == 10.0
    assert metrics.p95_ms == 20.0
    assert metrics.p99_ms == 30.0


def test_only_p75_present_p90_still_none():
    """Partial collection (e.g. a hand-edited or unusual results.json) is
    handled independently per field -- never all-or-nothing."""
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        results_path = _write(
            Path(d), {"p(50)": 10.0, "p(75)": 14.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0}
        )
        metrics = parse_results(results_path, duration_s=10.0)
        assert metrics.p75_ms == 14.0
        assert metrics.p90_ms is None


def test_real_fixture_predating_p75_p90_still_parses_with_both_none():
    fixture = Path(__file__).parent / "fixtures" / "real_pass_results.json"
    metrics = parse_results(fixture, duration_s=5.0)
    assert metrics.p75_ms is None
    assert metrics.p90_ms is None
    assert metrics.p50_ms == 0.602818
