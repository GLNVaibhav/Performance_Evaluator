"""Minimal, targeted redaction -- not a logging framework. One function,
used at the small number of call sites that build an error/log message
from data that might (even if it structurally shouldn't) contain a raw
secret: app/services/k6_engine/engine.py's pre-execution error messages
and app/services/run_service.py's execute_run exception handler.

Why these specific call sites and not "everywhere": every other place a
secret could theoretically leak is closed structurally instead --
AuthConfig's SecretStr fields never print themselves (see
app/schemas/auth.py), the generated k6 script never receives the secret
(script_renderer.py unmodified -- see docs/target_auth_contract.md), and
`TestResult`/`EngineExecutionOutcome`/`RunStatusResponse` have no field an
AuthConfig could occupy in the first place. This module exists for the
one remaining case those structural guarantees don't cover: a raw
exception's `str(exc)` (e.g. from httpx, or a k6 stderr line) that -- if
some future code path ever DID pass a secret into a header dict handed to
httpx -- could otherwise echo it back inside an error string that
`error_message`/logs do carry.
"""
from __future__ import annotations

from typing import Iterable, Optional

_MASK = "***REDACTED***"


def redact_secrets(text: str, secrets: Iterable[Optional[str]]) -> str:
    """Replaces every literal occurrence of each non-empty string in
    `secrets` with a fixed mask. Order-independent, safe to call with an
    empty/all-None iterable (returns `text` unchanged)."""
    result = text
    for secret in secrets:
        if secret:
            result = result.replace(secret, _MASK)
    return result
