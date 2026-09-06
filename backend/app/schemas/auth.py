"""Authentication contract for a TestPlan's target (app/schemas/test_plan.py::
TargetConfig). Structurally separate from UniversalPerformanceIntent
(app/schemas/intent.py) on purpose -- the intent layer has no target
concept at all (confirmed: `TargetConfig` appears only in `test_plan.py`
and `run.py`), and this module must not change that. Authentication is
supplied alongside `target`/`plan` at the execution boundary (`POST
/api/v1/runs`'s `RunCreateRequest.target`), never as part of natural-
language intent.

SECRET ISOLATION (the reason this file exists as a separate module):

  AuthConfig        -- carries the actual secret (token / api_key), using
                        pydantic's SecretStr so it is never visible in a
                        repr/str/traceback and is masked ("**********")
                        whenever serialized to JSON by default. This is
                        the ONLY schema in this codebase allowed to hold a
                        raw credential.

  SanitizedAuthMetadata / sanitize_auth() -- the ONLY representation of
                        auth information any future LLM-facing or
                        human-facing "here's what I found" surface may
                        ever consume. It is structurally incapable of
                        carrying a secret (it has no field that could hold
                        one) -- {"auth_available": bool, "auth_type": str
                        | null}, exactly the shape the LLM/auth-boundary
                        design requires.

The actual secret is unmasked (via `.get_secret_value()`) in exactly one
place in the whole codebase: app/services/auth_headers.py::
build_auth_headers(), called only immediately before an outbound HTTP
request the backend itself makes (OpenAPI discovery fetch). It is never
read by app/services/llm_intent_interpreter.py, app/services/
intent_compiler.py, or anything under app/services/k6_engine/ (the
generated k6 script never receives it -- see docs/target_auth_contract.md
for the documented tradeoff).
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, SecretStr, model_validator


class AuthType(str, Enum):
    """Supported authentication mechanisms -- kept deliberately small
    (only what this project's execution path can actually use today).
    Basic auth, OAuth2 flows, mTLS, etc. are NOT supported: no code path
    exists to use them, and adding the enum member without a consumer
    would be exactly the kind of unused surface this project avoids
    elsewhere (see app/schemas/intent.py::BusinessFlow for the same
    principle applied to an unimplemented feature)."""

    none = "none"
    bearer = "bearer"
    api_key_header = "api_key_header"


class AuthConfig(BaseModel):
    """Real credential material. `type` determines which other field(s)
    are required; unused fields for the chosen type must be absent (never
    silently ignored) -- an orphan secret sitting on the wrong field is a
    configuration mistake, not something to paper over.

    `token`/`api_key` are `SecretStr`: masked in repr/str and in the
    default JSON serialization pydantic produces (FastAPI's response
    encoding included) -- so even a future programming mistake that
    accidentally returns an `AuthConfig` in an API response or a log
    statement does not print the raw secret. This does not exempt calling
    code from also making sure `AuthConfig` itself never travels to such a
    place -- see `TargetConfig`'s docstring in app/schemas/test_plan.py --
    it is a second, structural layer of defense, not the only one.
    """

    type: AuthType = AuthType.none
    token: Optional[SecretStr] = None
    header_name: Optional[str] = None
    api_key: Optional[SecretStr] = None

    @model_validator(mode="after")
    def _validate_fields_match_type(self) -> "AuthConfig":
        def _blank(s: Optional[SecretStr]) -> bool:
            return s is None or not s.get_secret_value().strip()

        if self.type == AuthType.none:
            if self.token is not None or self.api_key is not None or self.header_name is not None:
                raise ValueError(
                    "auth.type is 'none' but a credential field (token/api_key/header_name) "
                    "was supplied -- omit them, or set a real auth.type"
                )
            return self

        if self.type == AuthType.bearer:
            if self.header_name is not None or self.api_key is not None:
                raise ValueError("auth.type is 'bearer' -- only 'token' applies, not 'header_name'/'api_key'")
            if _blank(self.token):
                raise ValueError("auth.type is 'bearer' but 'token' is missing or blank")
            return self

        if self.type == AuthType.api_key_header:
            if self.token is not None:
                raise ValueError("auth.type is 'api_key_header' -- 'token' does not apply, use 'api_key'")
            if not self.header_name or not self.header_name.strip():
                raise ValueError("auth.type is 'api_key_header' but 'header_name' is missing or blank")
            if _blank(self.api_key):
                raise ValueError("auth.type is 'api_key_header' but 'api_key' is missing or blank")
            return self

        return self  # unreachable: AuthType is a closed enum


class SanitizedAuthMetadata(BaseModel):
    """LLM-safe / human-safe view of an AuthConfig. Structurally cannot
    carry a raw secret -- there is no field here capable of holding one.
    This is what any future planning/interpretation layer receives about
    authentication; never the AuthConfig itself."""

    auth_available: bool
    auth_type: Optional[AuthType] = None


def sanitize_auth(auth: Optional[AuthConfig]) -> SanitizedAuthMetadata:
    """The one, single conversion point from real credential config to the
    sanitized shape. Every future caller that needs to describe auth to an
    LLM prompt, a UI, or a log line must go through this function rather
    than hand-rolling an equivalent dict from `AuthConfig` fields."""
    if auth is None or auth.type == AuthType.none:
        return SanitizedAuthMetadata(auth_available=False, auth_type=None)
    return SanitizedAuthMetadata(auth_available=True, auth_type=auth.type)
