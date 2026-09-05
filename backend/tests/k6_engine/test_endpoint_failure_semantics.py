"""Regression coverage for a confirmed defect in per-endpoint failure
counting (app/services/k6_engine/metrics_parser.py::_parse_one_endpoint).

THE BUG: k6's Rate-metric JSON export (--summary-export) names its
"passes"/"fails" fields from the point of view of the RATE CONDITION being
tracked, not from an HTTP-success point of view. For `http_req_failed`,
the tracked condition is "this request failed", so:

    passes = samples where the condition was TRUE  = requests that FAILED
    fails  = samples where the condition was FALSE = requests that SUCCEEDED

The original implementation read `fails` as "the number of failed
requests" -- exactly backwards. This was caught during a real k6 v2.2.0
execution against the live demo API: a completely healthy /products
endpoint (error_rate=0.0) was reported with failed_requests equal to its
FULL request count.

WHY THIS IS NOT AN ASSUMPTION: it is verified two independent ways here,
both from data no human hand-typed:

  1. `tests/k6_engine/fixtures/real_fail_results.json` -- an aggregate
     http_req_failed capture from an earlier real k6 run against the demo
     API (predates this feature): {"passes": 35, "fails": 80,
     "value": 0.30434782608695654} against 115 total requests.
     35 / 115 == 0.30434782608695654 exactly, and 35 + 80 == 115. Only
     "passes == actual failures" is consistent with that arithmetic.
  2. A live k6 v2.2.0 run performed for this feature (see
     docs/performance_engine_interface.md "Amendment: endpoint mix +
     per-endpoint evidence") against a real target in error_injection mode
     showed the same pattern for a TAGGED submetric.

Cases A-D below reproduce exactly the scenarios from the stabilization
brief, at the tagged-submetric level (the code path the original bug was
actually in -- the aggregate parser never touched passes/fails and was
never affected).
"""
import json
from pathlib import Path

import pytest

from app.services.k6_engine.metrics_parser import parse_results
from app.services.k6_engine.script_renderer import EndpointTagInfo

_TAG = EndpointTagInfo(alias="endpoint_0", endpoint="/products", method="GET")

# Shared, valid duration-stat shape so only http_req_failed varies between
# cases -- p50/p95/p99/avg/max must all be present or _parse_one_endpoint
# omits the endpoint entirely (see its docstring), which would mask the
# passes/fails bug behind a different code path.
_DURATION_STATS = {"p(50)": 10.0, "p(95)": 20.0, "p(99)": 30.0, "avg": 12.0, "max": 40.0}


def _write_results(tmp_path: Path, *, total_requests: int, http_req_failed: dict) -> Path:
    data = {
        "metrics": {
            "http_req_duration": _DURATION_STATS,
            "http_reqs": {"count": total_requests, "rate": total_requests / 8.0},
            "http_req_failed": {"value": 0.0},  # aggregate: unused by the tagged lookup, kept structurally valid
            "http_req_duration{endpoint:endpoint_0}": _DURATION_STATS,
            "http_reqs{endpoint:endpoint_0}": {"count": total_requests, "rate": total_requests / 8.0},
            "http_req_failed{endpoint:endpoint_0}": http_req_failed,
        }
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(data))
    return path


# --- Case A: zero failures ------------------------------------------------


def test_case_a_zero_failures_reports_zero_failed_requests_not_total_count(tmp_path):
    """{"passes": 0, "fails": 100, "value": 0} -- this is what a fully
    healthy endpoint looks like in real k6 output (see
    real_pass_results.json). The old (buggy) code read `fails` (100) as
    the failure count, which would claim every single request failed on a
    100%-healthy endpoint."""
    path = _write_results(tmp_path, total_requests=100, http_req_failed={"passes": 0, "fails": 100, "value": 0})
    metrics = parse_results(path, duration_s=8.0, endpoint_tags=[_TAG])

    assert len(metrics.per_endpoint) == 1
    ep = metrics.per_endpoint[0]
    assert ep.error_rate == 0
    assert ep.failed_requests == 0  # NOT 100


# --- Case B: partial failures ----------------------------------------------


def test_case_b_partial_failures_uses_passes_as_the_real_failure_count(tmp_path):
    """{"passes": 25, "fails": 75, "value": 0.25} -- 25 of 100 requests
    genuinely failed. The old (buggy) code would have reported 75 failed
    requests (the SUCCESS count) instead of 25."""
    path = _write_results(tmp_path, total_requests=100, http_req_failed={"passes": 25, "fails": 75, "value": 0.25})
    metrics = parse_results(path, duration_s=8.0, endpoint_tags=[_TAG])

    ep = metrics.per_endpoint[0]
    assert ep.error_rate == 0.25
    assert ep.failed_requests == 25  # NOT 75


# --- Case C: all failures ----------------------------------------------


def test_case_c_all_failures_reports_full_failure_count(tmp_path):
    """{"passes": 100, "fails": 0, "value": 1.0} -- every request failed.
    The old (buggy) code would have reported 0 failed requests on a
    100%-failing endpoint -- the exact inverse of reality."""
    path = _write_results(tmp_path, total_requests=100, http_req_failed={"passes": 100, "fails": 0, "value": 1.0})
    metrics = parse_results(path, duration_s=8.0, endpoint_tags=[_TAG])

    ep = metrics.per_endpoint[0]
    assert ep.error_rate == 1.0
    assert ep.failed_requests == 100  # NOT 0


# --- Case D: missing passes -> deterministic fallback -----------------


def test_case_d_missing_passes_falls_back_to_error_rate_times_total(tmp_path):
    """When a k6 build/version omits "passes" from the tagged submetric,
    fall back to the same deterministic formula the (always-correct)
    aggregate parser has used from the start: round(error_rate *
    total_requests). This is a fallback, never the primary path -- Cases
    A-C prove the primary path (real "passes" count) is preferred whenever
    it's available."""
    path = _write_results(tmp_path, total_requests=100, http_req_failed={"value": 0.25})  # no passes/fails at all
    metrics = parse_results(path, duration_s=8.0, endpoint_tags=[_TAG])

    ep = metrics.per_endpoint[0]
    assert ep.error_rate == 0.25
    assert ep.failed_requests == round(0.25 * 100) == 25


# --- Independent corroboration from a real, pre-existing repo fixture -----


def test_real_captured_fixture_independently_confirms_passes_semantics():
    """Not synthetic: an aggregate http_req_failed capture from an actual
    earlier k6 run against the demo API (tests/k6_engine/fixtures/
    real_fail_results.json), predating this feature. Only "passes ==
    actual failures" is arithmetically consistent with it."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "real_fail_results.json").read_text())
    failed = fixture["metrics"]["http_req_failed"]
    total_requests = fixture["metrics"]["http_reqs"]["count"]

    assert failed["passes"] + failed["fails"] == total_requests
    assert failed["passes"] / total_requests == pytest.approx(failed["value"])
    # Confirms passes is the real-failure count, not fails.
    assert failed["fails"] / total_requests != pytest.approx(failed["value"])
