"""The ONE place in this codebase where an AuthConfig's real secret is ever
unmasked (`.get_secret_value()`). Called only immediately before an
outbound HTTP request the backend itself makes for OpenAPI discovery
(app/services/k6_engine/openapi_loader.py via app/services/
target_validation.py and app/services/k6_engine/engine.py) -- never by
app/services/llm_intent_interpreter.py, app/services/intent_compiler.py,
or anything that persists to the database or returns an API response.

Deliberately NOT used to inject auth into the generated k6 script
(app/services/k6_engine/script_renderer.py is unmodified by this work) --
see docs/target_auth_contract.md for that explicit, documented scope
decision and its tradeoff.
"""
from __future__ import annotations

from typing import Dict, Optional

from app.schemas.auth import AuthConfig, AuthType


def build_auth_headers(auth: Optional[AuthConfig]) -> Dict[str, str]:
    """Returns the HTTP header(s) needed to authenticate a request as
    `auth` describes, or `{}` for `None`/`AuthType.none` -- `{}` is exactly
    the "no extra headers" value every existing caller already passed
    implicitly, so this function is safe to call unconditionally at every
    OpenAPI-fetch call site without changing behavior for a target with no
    auth configured. Always exactly zero or one header, by construction
    (AuthConfig only ever describes a single header) -- relied on by
    build_auth_env() below."""
    if auth is None or auth.type == AuthType.none:
        return {}
    if auth.type == AuthType.bearer:
        assert auth.token is not None  # enforced by AuthConfig's own validator
        return {"Authorization": f"Bearer {auth.token.get_secret_value()}"}
    if auth.type == AuthType.api_key_header:
        assert auth.header_name is not None and auth.api_key is not None
        return {auth.header_name: auth.api_key.get_secret_value()}
    raise ValueError(f"unsupported auth type: {auth.type!r}")  # unreachable: AuthType is a closed enum


# Fixed, generic env-var names the generated k6 script (app/services/
# k6_engine/script_renderer.py) reads via k6's __ENV global. Deliberately
# NOT auth-type-specific: both `bearer` and `api_key_header` resolve to
# exactly one (header name, header value) pair via build_auth_headers()
# above, so one generic (name, value) env-var pair covers both without the
# generated script ever needing to know which auth type was configured.
K6_ENV_AUTH_HEADER_NAME = "PERF_EVAL_AUTH_HEADER_NAME"
K6_ENV_AUTH_HEADER_VALUE = "PERF_EVAL_AUTH_HEADER_VALUE"


def build_auth_env(auth: Optional[AuthConfig]) -> Dict[str, str]:
    """The env-var pair to pass to the k6 SUBPROCESS's environment only
    (app/services/k6_engine/k6_runner.py::run_k6()'s `env` parameter) --
    never written to script.js, never logged, never persisted. `{}` for
    no-auth, exactly like build_auth_headers(). See
    docs/target_auth_contract.md for the verified mechanism (k6's __ENV)
    against the pinned k6 v2.2.0 binary."""
    headers = build_auth_headers(auth)
    if not headers:
        return {}
    ((name, value),) = headers.items()  # exactly one header, by construction
    return {K6_ENV_AUTH_HEADER_NAME: name, K6_ENV_AUTH_HEADER_VALUE: value}
