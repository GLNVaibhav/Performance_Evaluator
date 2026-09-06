"""Tiny shared helper: the raw secret value(s), if any, an AuthConfig
carries -- used ONLY to feed app/services/secret_redaction.py::
redact_secrets() a scrub list at the few call sites that build an error
message from data that might otherwise echo one back (see that module's
docstring for why only those specific sites need this). Not a general
"get the secret" API -- app/services/auth_headers.py remains the one
place a secret is unmasked to actually authenticate a request.
"""
from __future__ import annotations

from typing import List, Optional

from app.schemas.test_plan import TargetConfig


def auth_secret_values(target: TargetConfig) -> List[str]:
    auth = target.auth
    if auth is None:
        return []
    values: List[Optional[str]] = []
    if auth.token is not None:
        values.append(auth.token.get_secret_value())
    if auth.api_key is not None:
        values.append(auth.api_key.get_secret_value())
    return [v for v in values if v]
