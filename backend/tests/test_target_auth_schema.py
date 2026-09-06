"""Session 1: TargetConfig/AuthConfig contract tests.

Covers: valid/invalid OpenAPI URL and base_url syntax, supported auth
configurations, missing required fields per auth type, and -- the core
security property -- that a raw credential never appears in the
LLM-facing sanitized view (app/schemas/auth.py::sanitize_auth()).
"""
import pytest
from pydantic import ValidationError

from app.schemas.auth import AuthConfig, AuthType, sanitize_auth
from app.schemas.test_plan import TargetConfig


# --- base_url / openapi_url syntax --------------------------------------


def test_valid_http_base_url_is_accepted():
    TargetConfig(base_url="http://127.0.0.1:8080")  # must not raise


def test_valid_https_openapi_url_is_accepted():
    TargetConfig(base_url="http://127.0.0.1:8080", openapi_url="https://example.com/openapi.json")


def test_openapi_url_is_optional():
    target = TargetConfig(base_url="http://127.0.0.1:8080")
    assert target.openapi_url is None


@pytest.mark.parametrize(
    "bad_url",
    ["ftp://example.com/openapi.json", "not-a-url", "", "   ", "javascript:alert(1)"],
)
def test_invalid_openapi_url_scheme_is_rejected(bad_url):
    with pytest.raises(ValidationError):
        TargetConfig(base_url="http://127.0.0.1:8080", openapi_url=bad_url)


@pytest.mark.parametrize("bad_url", ["ftp://example.com", "not-a-url", ""])
def test_invalid_base_url_scheme_is_rejected(bad_url):
    with pytest.raises(ValidationError):
        TargetConfig(base_url=bad_url)


def test_base_url_with_embedded_credentials_is_rejected():
    with pytest.raises(ValidationError):
        TargetConfig(base_url="http://user:secret@example.com")


def test_openapi_url_with_embedded_credentials_is_rejected():
    with pytest.raises(ValidationError):
        TargetConfig(base_url="http://127.0.0.1:8080", openapi_url="https://user:secret@example.com/openapi.json")


def test_injection_style_base_url_starting_with_http_is_still_accepted():
    """Regression guard: tests/k6_engine/test_script_renderer_injection.py
    deliberately constructs TargetConfig with adversarial-but-http-prefixed
    base_url strings to prove the k6 renderer's encoding-based defense.
    Schema validation here must stay lenient enough to allow them through
    -- rejecting them at the schema layer would silently disable that
    test suite's coverage, not make the system safer (the renderer's
    json.dumps encoding is what actually neutralizes such payloads)."""
    payload = "http://evil.example'; globalThis.injected=true; //"
    target = TargetConfig(base_url=payload)  # must not raise
    assert target.base_url == payload


# --- AuthConfig: supported configurations --------------------------------


def test_auth_none_with_no_credentials_is_valid():
    auth = AuthConfig(type=AuthType.none)
    assert auth.token is None
    assert auth.api_key is None


def test_bearer_with_token_is_valid():
    auth = AuthConfig(type=AuthType.bearer, token="secret-token-value")
    assert auth.token.get_secret_value() == "secret-token-value"


def test_api_key_header_with_header_and_key_is_valid():
    auth = AuthConfig(type=AuthType.api_key_header, header_name="X-API-Key", api_key="secret-key-value")
    assert auth.api_key.get_secret_value() == "secret-key-value"


# --- AuthConfig: missing/invalid required fields -------------------------


def test_bearer_without_token_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.bearer)


def test_bearer_with_blank_token_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.bearer, token="   ")


def test_api_key_header_without_header_name_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.api_key_header, api_key="secret-key-value")


def test_api_key_header_without_api_key_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.api_key_header, header_name="X-API-Key")


def test_api_key_header_with_blank_api_key_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.api_key_header, header_name="X-API-Key", api_key="   ")


def test_none_type_with_orphan_token_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.none, token="unexpected-secret")


def test_bearer_with_api_key_header_fields_is_rejected():
    """Fields for the wrong auth type must fail clearly, not be silently
    ignored (Session 2 item 7's requirement, exercised here at the schema
    boundary)."""
    with pytest.raises(ValidationError):
        AuthConfig(type=AuthType.bearer, token="t", header_name="X-API-Key")


def test_unrecognized_auth_type_is_rejected():
    with pytest.raises(ValidationError):
        AuthConfig(type="oauth2", token="t")


# --- Secret isolation: the core property ---------------------------------


def test_sanitize_auth_none_reports_unavailable():
    sanitized = sanitize_auth(None)
    assert sanitized.auth_available is False
    assert sanitized.auth_type is None


def test_sanitize_auth_type_none_reports_unavailable():
    sanitized = sanitize_auth(AuthConfig(type=AuthType.none))
    assert sanitized.auth_available is False
    assert sanitized.auth_type is None


def test_sanitize_auth_bearer_reports_available_and_type_only():
    auth = AuthConfig(type=AuthType.bearer, token="super-secret-value")
    sanitized = sanitize_auth(auth)
    assert sanitized.auth_available is True
    assert sanitized.auth_type == AuthType.bearer
    # The sanitized model has NO field that could hold the secret at all --
    # this is a structural guarantee, not just "we didn't happen to copy
    # it in this implementation".
    assert not hasattr(sanitized, "token")
    assert not hasattr(sanitized, "api_key")
    assert "super-secret-value" not in sanitized.model_dump_json()


def test_secret_str_is_masked_in_repr_and_str():
    auth = AuthConfig(type=AuthType.bearer, token="super-secret-value")
    assert "super-secret-value" not in repr(auth)
    assert "super-secret-value" not in str(auth)


def test_secret_str_is_masked_in_default_json_serialization():
    auth = AuthConfig(type=AuthType.bearer, token="super-secret-value")
    assert "super-secret-value" not in auth.model_dump_json()


def test_target_config_auth_is_optional_and_backward_compatible():
    """The single most important backward-compatibility property: every
    existing caller that constructs TargetConfig(base_url=...) with no
    `auth`/`openapi_url` at all must keep working unchanged."""
    target = TargetConfig(base_url="http://127.0.0.1:8080")
    assert target.auth is None
    assert target.openapi_url is None
