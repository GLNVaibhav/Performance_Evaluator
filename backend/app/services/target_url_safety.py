"""Hackathon-grade SSRF defense for user-supplied target/OpenAPI URLs.

Because a user now supplies an arbitrary OpenAPI URL (and, less often, an
arbitrary base_url), the backend's own OpenAPI-discovery fetch
(app/services/k6_engine/openapi_loader.py, invoked from
app/services/target_validation.py and app/services/k6_engine/engine.py)
is a real SSRF surface: it will make an outbound HTTP request to wherever
that URL resolves, from the backend's own network position.

DELIBERATELY NOT enterprise-grade. This module:
  - resolves the hostname via DNS and checks the resolved IP(s) against a
    small, fixed blocklist -- it does NOT re-check on redirect (httpx's
    default here is `follow_redirects=False`; a 3xx response fails the
    existing `status_code != 200` check in openapi_loader.py and is
    already rejected as OpenAPILoadError, so no separate redirect-chasing
    logic exists to bypass),
  - does NOT protect against DNS-rebinding (resolve-then-check-then-fetch
    is not atomic; a sufficiently adversarial DNS server could change the
    answer between this check and the actual fetch a moment later),
  - does NOT inspect IPv4-mapped-IPv6 or other exotic encodings beyond
    what Python's `ipaddress` module already normalizes.
These are documented, accepted gaps for this project's scope, not
oversights.

THE ONE POLICY DECISION THAT MATTERS FOR THIS PROJECT SPECIFICALLY: the
canonical demo API, this project's own test suite, and the documented MVP
scope ("local/staging/sandbox only", never production -- see
docs/performance_engine_interface.md) all legitimately target
127.0.0.1/loopback. A naive "block all private/loopback addresses"
default would break the project's own primary supported use case. So:
loopback/private/link-local-except-metadata addresses are ALLOWED by
default (`TARGET_SSRF_POLICY=allow_private`); a stricter
`TARGET_SSRF_POLICY=block_private` is available (env-configurable, see
app/core/config.py) for a deployment where that tradeoff is wrong. Cloud
metadata / link-local addresses (169.254.0.0/16, including the common
169.254.169.254 metadata IP; Alibaba Cloud's 100.100.100.200) have no
legitimate performance-test use case at all and are blocked
UNCONDITIONALLY, regardless of policy.

Same deliberate asymmetry as app/services/target_validation.py: a
hostname that fails to resolve at all does NOT raise here -- "can't
verify" is not "verified dangerous". This function only rejects a host
that resolves to a demonstrably blocked address; an unreachable/
nonexistent host is deferred to the actual fetch, which will fail on its
own with a clear, unrelated error.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import List, Optional
from urllib.parse import urlparse

from app.core.config import TARGET_SSRF_POLICY

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class TargetURLSafetyError(Exception):
    """A URL's resolved address is on the blocklist. Distinct from
    OpenAPILoadError (app/services/k6_engine/openapi_loader.py) -- this is
    a policy rejection made BEFORE any fetch is attempted, not a fetch
    failure."""


_ALWAYS_BLOCKED_NETWORKS = [
    ipaddress.ip_network("169.254.0.0/16"),  # link-local; covers the AWS/Azure/GCP metadata IP 169.254.169.254
    ipaddress.ip_network("100.100.100.200/32"),  # Alibaba Cloud metadata
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
]

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def _blocked_reason(ip: IPAddress) -> Optional[str]:
    for network in _ALWAYS_BLOCKED_NETWORKS:
        if ip in network:
            return "link-local/cloud-metadata address"
    if TARGET_SSRF_POLICY == "block_private":
        for network in _PRIVATE_NETWORKS:
            if ip in network:
                return "private/loopback address (TARGET_SSRF_POLICY=block_private)"
    return None


def _resolve(hostname: str) -> List[str]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return []  # cannot resolve -- not this function's concern, see module docstring
    return [info[4][0] for info in infos]


def validate_target_url_safety(url: str) -> None:
    """Raises TargetURLSafetyError iff `url`'s hostname resolves to a
    blocked address. Never raises for an unparseable/unresolvable
    hostname -- that is deferred to the real fetch, exactly like
    app/services/target_validation.py's own asymmetry."""
    hostname = urlparse(url).hostname
    if not hostname:
        return

    for ip_str in _resolve(hostname):
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        reason = _blocked_reason(ip)
        if reason is not None:
            raise TargetURLSafetyError(f"target host {hostname!r} resolves to a blocked address ({reason})")
