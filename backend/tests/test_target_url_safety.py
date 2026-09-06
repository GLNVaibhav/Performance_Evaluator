"""Session 2: SSRF gate (app/services/target_url_safety.py).

Verifies the one policy decision that matters for this project: loopback
(127.0.0.1, the demo API's own address, and this project's own test
suite's placeholder targets) is allowed by default, cloud-metadata/
link-local addresses are always blocked, and TARGET_SSRF_POLICY=block_private
additionally blocks loopback/private -- without needing a live network
target for the always-blocked and default-allow cases (pure IP-literal
resolution, no DNS).
"""
import importlib

import pytest

from app.services import target_url_safety
from app.services.target_url_safety import TargetURLSafetyError, validate_target_url_safety


def test_loopback_is_allowed_by_default():
    validate_target_url_safety("http://127.0.0.1:8080")  # must not raise


def test_localhost_ipv6_loopback_is_allowed_by_default():
    validate_target_url_safety("http://[::1]:8080")  # must not raise


def test_private_rfc1918_address_is_allowed_by_default():
    validate_target_url_safety("http://192.168.1.50:8080")  # must not raise


def test_public_looking_address_is_allowed():
    validate_target_url_safety("http://93.184.216.34")  # example.com's old IP -- not blocked


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # AWS/Azure/GCP metadata
        "http://169.254.169.254",
        "http://100.100.100.200",  # Alibaba Cloud metadata
    ],
)
def test_cloud_metadata_addresses_are_always_blocked(url):
    with pytest.raises(TargetURLSafetyError):
        validate_target_url_safety(url)


def test_link_local_ipv6_is_always_blocked():
    with pytest.raises(TargetURLSafetyError):
        validate_target_url_safety("http://[fe80::1]")


def test_unresolvable_hostname_does_not_raise():
    """Deliberate asymmetry, matching app/services/target_validation.py:
    "can't verify" must never be treated as "verified dangerous"."""
    validate_target_url_safety("http://this-host-does-not-exist.invalid")  # must not raise


def test_url_with_no_hostname_does_not_raise():
    validate_target_url_safety("not-a-url-at-all")  # must not raise -- not this function's job


def test_block_private_policy_rejects_loopback(monkeypatch):
    monkeypatch.setattr(target_url_safety, "TARGET_SSRF_POLICY", "block_private")
    with pytest.raises(TargetURLSafetyError):
        validate_target_url_safety("http://127.0.0.1:8080")


def test_block_private_policy_rejects_rfc1918(monkeypatch):
    monkeypatch.setattr(target_url_safety, "TARGET_SSRF_POLICY", "block_private")
    with pytest.raises(TargetURLSafetyError):
        validate_target_url_safety("http://10.0.0.5")


def test_block_private_policy_still_blocks_metadata(monkeypatch):
    monkeypatch.setattr(target_url_safety, "TARGET_SSRF_POLICY", "block_private")
    with pytest.raises(TargetURLSafetyError):
        validate_target_url_safety("http://169.254.169.254")


def test_block_private_policy_still_allows_public_address(monkeypatch):
    monkeypatch.setattr(target_url_safety, "TARGET_SSRF_POLICY", "block_private")
    validate_target_url_safety("http://93.184.216.34")  # must not raise


# --- Wired into the run-creation gate -------------------------------------


def test_run_creation_rejects_metadata_target_with_422(client):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 5,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.5},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://169.254.169.254"}},
    )
    assert resp.status_code == 422


def test_run_creation_with_loopback_target_is_unaffected(client):
    """Regression guard: this project's own test suite and demo workflow
    submit loopback targets to POST /api/v1/runs constantly -- the SSRF
    gate must not break that (default policy allows loopback)."""
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 5,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.5},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://127.0.0.1:1"}},
    )
    # Unreachable (port 1) but NOT rejected by the SSRF gate -- proceeds to
    # the (also-permissive-for-unreachable) target-compatibility gate and
    # succeeds in creating a QUEUED run, exactly as before this gate existed.
    assert resp.status_code == 201
