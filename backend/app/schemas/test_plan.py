import re
from typing import Annotated, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, PositiveInt, field_validator, model_validator

from app.schemas.auth import AuthConfig
from app.schemas.enums import ObjectiveType, PayloadStrategy, TestType

# k6-style duration string, e.g. "5s", "20s", "2m". This is a plain config
# value, never JavaScript, and never LLM-authored. The renderer (owned by
# Developer 2) is responsible for turning it into an actual k6 stage.
DURATION_PATTERN = r"^\d+(ms|s|m|h)$"


class Thresholds(BaseModel):
    p95_latency_ms: PositiveInt
    error_rate: float = Field(ge=0, le=1)


class _PlanBase(BaseModel):
    test_type: TestType
    thresholds: Thresholds
    selected_endpoints: List[str] = Field(min_length=1)
    # Additive amendment (endpoint mix, local/pending gate review -- see
    # docs/performance_engine_interface.md "Amendment: endpoint mix +
    # per-endpoint evidence"). Optional and backward compatible: omitting
    # it (the only option before this amendment) preserves the original
    # uniform-random dispatch across selected_endpoints unchanged. When
    # given, every selected_endpoints entry must have exactly one weight
    # (no more, no less) so there is never an implicit/ambiguous weight for
    # an endpoint the plan explicitly selected.
    endpoint_weights: Optional[Dict[str, float]] = None
    # Additive (Session 3): selects among app/services/k6_engine/
    # payload_generator.py's two fixed, deterministic generation rules.
    # Defaulting to `normal` reproduces the exact pre-existing behavior for
    # every plan constructed before this field existed -- omitting it is
    # indistinguishable from explicitly requesting `normal`.
    payload_strategy: PayloadStrategy = PayloadStrategy.normal
    assumptions: List[str] = Field(default_factory=list)
    target_vus: PositiveInt

    @field_validator("selected_endpoints")
    @classmethod
    def _endpoints_nonempty(cls, v: List[str]) -> List[str]:
        if any(not e.strip() for e in v):
            raise ValueError("selected_endpoints entries must be non-empty")
        return v

    @model_validator(mode="after")
    def _validate_endpoint_weights(self) -> "_PlanBase":
        if self.endpoint_weights is None:
            return self

        selected = set(self.selected_endpoints)
        weighted = set(self.endpoint_weights.keys())
        if weighted != selected:
            problems = []
            missing = selected - weighted
            extra = weighted - selected
            if missing:
                problems.append(f"missing weight for {sorted(missing)}")
            if extra:
                problems.append(f"weight given for unselected endpoint(s) {sorted(extra)}")
            raise ValueError(
                "endpoint_weights must cover exactly selected_endpoints, no more and no less: "
                + "; ".join(problems)
            )

        non_positive = {e: w for e, w in self.endpoint_weights.items() if not w > 0}
        if non_positive:
            raise ValueError(f"endpoint_weights must be > 0, got non-positive weight(s): {non_positive}")

        return self


def _duration_field() -> Field:
    return Field(pattern=DURATION_PATTERN)


class BoundarySearchPlan(_PlanBase):
    """One target VU level per experiment. This is the unit the adaptive
    boundary-search engine (Phase 2+) operates on -- it is not a multi-stage
    stress ladder."""

    objective_type: Literal[ObjectiveType.boundary_search] = ObjectiveType.boundary_search
    ramp_duration: str = _duration_field()
    hold_duration: str = _duration_field()


class FixedLoadPlan(_PlanBase):
    objective_type: Literal[ObjectiveType.fixed_load] = ObjectiveType.fixed_load
    duration: str = _duration_field()


TestPlan = Annotated[
    Union[BoundarySearchPlan, FixedLoadPlan],
    Field(discriminator="objective_type"),
]


_URL_SCHEME_RE = re.compile(r"^https?://", re.IGNORECASE)
_EMBEDDED_CREDENTIALS_RE = re.compile(r"^https?://[^/]*@", re.IGNORECASE)


def _validate_url_scheme(value: str, *, field_name: str) -> str:
    """Deliberately lenient -- checks only that the value is a non-empty
    string starting with an http(s) scheme and does not embed credentials
    in the URL itself (`user:pass@host`, a classic secret-leak vector: it
    ends up in access logs, browser history, and Referer headers).

    This is NOT a general URL/RFC validator, and specifically does NOT
    attempt full parsing (scheme+host extraction, IDNA, etc.) -- see
    tests/k6_engine/test_script_renderer_injection.py, which deliberately
    constructs `TargetConfig(base_url=<adversarial-but-http-prefixed
    string>)` to prove the k6 script renderer's encoding-based injection
    defense (json.dumps-equivalent string literals, never JS syntax). A
    stricter validator here (e.g. requiring a parseable hostname) would
    reject those payloads at schema-construction time, defeating that test
    suite's purpose without making the system any safer -- the renderer's
    encoding is what actually neutralizes such payloads, not rejecting
    them at the door. Network-reachability / private-address (SSRF)
    checks are a separate, later gate (app/services/target_url_safety.py),
    not schema validation, since they require DNS resolution (I/O)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    if not _URL_SCHEME_RE.match(value):
        raise ValueError(f"{field_name} must start with 'http://' or 'https://'")
    if _EMBEDDED_CREDENTIALS_RE.match(value):
        raise ValueError(f"{field_name} must not embed credentials in the URL itself (user:pass@host)")
    return value


class TargetConfig(BaseModel):
    """Where the plan's endpoints are resolved against.

    `openapi_url` (optional): explicit location of the target's OpenAPI
    document, for a target whose spec is not served at
    `{base_url}/openapi.json` (the sole assumption `openapi_loader.py`
    made before this field existed). Omitting it preserves the original
    derivation exactly -- see app/services/k6_engine/openapi_loader.py::
    load_normalized(). Deliberately independent of `base_url`: the OpenAPI
    document can be discovered from a different host (e.g. a docs
    subdomain) than the one real test traffic is sent to. The system never
    infers one from the other, and never silently substitutes one host for
    the other -- see docs/target_auth_contract.md.

    `auth` (optional): real credential material (app/schemas/auth.py::
    AuthConfig) used ONLY to authenticate the backend's own OpenAPI
    discovery fetch (app/services/auth_headers.py::build_auth_headers()).
    It is never persisted to the database (app/services/
    target_context_store.py holds it in-memory, per-run, for the lifetime
    of that run only) and never reaches the LLM/intent layer -- see
    app/schemas/auth.py::sanitize_auth(). The generated k6 script does NOT
    currently receive it (script_renderer.py is unmodified by this work);
    see docs/target_auth_contract.md for that explicit, documented scope
    decision."""

    base_url: str
    openapi_url: Optional[str] = None
    auth: Optional[AuthConfig] = None

    @field_validator("base_url")
    @classmethod
    def _validate_base_url(cls, v: str) -> str:
        return _validate_url_scheme(v, field_name="target.base_url")

    @field_validator("openapi_url")
    @classmethod
    def _validate_openapi_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_url_scheme(v, field_name="target.openapi_url")
