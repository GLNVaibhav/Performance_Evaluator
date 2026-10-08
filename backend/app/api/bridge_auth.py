"""Execution-bridge authentication and admission control.

The bridge contract (Freebuff/Convex control plane -> this execution plane)
authenticates with a static bearer token:

    Authorization: Bearer $EXECUTION_BRIDGE_TOKEN

Design rules:
- The token is OPTIONAL by environment: when EXECUTION_BRIDGE_TOKEN is unset
  (local development, the project's documented MVP posture), requests are
  NOT rejected -- existing local behavior is unchanged. When set, EVERY
  /api/v1/runs* route (the only routes that cost real k6 subprocess
  executions or reveal run results) requires the exact token. Nothing about
  the token's value is ever logged; failures return a bare 401 with no
  echo of the presented value.
- Convex reads the same value from its own environment (EXECUTION_BRIDGE_TOKEN)
  and presents it. Neither plane hardcodes the other's secret.
- A small, conservative in-process rate limit (per bridge token) protects the
  single-machine MVP execution plane from accidental submission floods. It is
  deliberately NOT a distributed limiter -- it bounds one process, which is
  exactly what this deployment is.
"""

import os
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

BRIDGE_TOKEN_ENV = "EXECUTION_BRIDGE_TOKEN"

_scheme = HTTPBearer(auto_error=False)

# Conservative admission window: per-token submission rate cap (Phase 3 #13).
_WINDOW_S = 60.0
_MAX_REQUESTS_PER_WINDOW = 30
_recent: dict[str, deque[float]] = defaultdict(deque)


def bridge_token_configured() -> bool:
    return bool(os.environ.get(BRIDGE_TOKEN_ENV, "").strip())


def _token_fingerprint(presented: str | None) -> str:
    """Stable, non-reversible label for rate-limit bucketing only. Never
    logged, never returned to a client, and never reversible to the token."""
    import hashlib

    return hashlib.sha256((presented or "").encode()).hexdigest()[:12]


def require_bridge_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_scheme),
) -> None:
    expected = os.environ.get(BRIDGE_TOKEN_ENV, "").strip()
    if not expected:
        # Local/dev posture: bridge auth not configured -> do not reject.
        return

    presented = credentials.credentials if credentials else None
    if not presented or presented != expected:
        raise HTTPException(status_code=401, detail="execution bridge authentication required")

    # Rate limit applies only to authenticated bridge traffic.
    now = time.monotonic()
    bucket = _recent[_token_fingerprint(presented)]
    while bucket and now - bucket[0] > _WINDOW_S:
        bucket.popleft()
    if len(bucket) >= _MAX_REQUESTS_PER_WINDOW:
        raise HTTPException(status_code=429, detail="execution bridge rate limit exceeded")
    bucket.append(now)
