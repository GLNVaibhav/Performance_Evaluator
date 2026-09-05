"""UniversalPerformanceIntent: the canonical representation of WHAT A USER
WANTS, as produced by an (out-of-scope) AI intent-interpretation layer from
natural language.

This is deliberately NOT a TestPlan. A TestPlan (app/schemas/test_plan.py)
answers "exactly how will the system execute this" -- objective_type,
target_vus, k6-style durations, thresholds -- and is frozen MVP contract
with the performance engine. An intent answers "what does the user want",
may be incomplete or ambiguous, and must never be executed directly.

Everything in this module is plain structural validation (pydantic). No
field here is interpreted by an LLM at this layer -- by the time a
UniversalPerformanceIntent reaches the backend, natural-language
interpretation has already happened upstream. The backend's job, done by
app/services/intent_compiler.py, is to deterministically decide whether the
intent is READY, NEEDS_CLARIFICATION, or INVALID, and if READY, compile it
into an existing, already-validated TestPlan.

See backend/docs/ai_intent_architecture.md for the full architecture.
"""

from typing import Dict, List, Optional

from pydantic import BaseModel, Field, PositiveInt, field_validator

from app.schemas.enums import IntentStatus, TestType
from app.schemas.test_plan import DURATION_PATTERN, TestPlan


class LoadProfile(BaseModel):
    """Which field applies depends on test_type (see intent_compiler.py):
    baseline/soak use concurrent_users (typical/expected load), stress uses
    peak_users (the ceiling to probe). The compiler never guesses one from
    the other -- if the field the test_type needs is absent, that is a
    NEEDS_CLARIFICATION, not a fallback."""

    concurrent_users: Optional[PositiveInt] = None
    peak_users: Optional[PositiveInt] = None


class TargetScope(BaseModel):
    """Endpoint-based targeting -- the only form the compiler can resolve
    for MVP. See BusinessFlow for the (currently unsupported) alternative."""

    endpoints: Optional[List[str]] = None
    # Additive (Phase 0 of the endpoint-intelligence integration). Mirrors
    # app/schemas/test_plan.py::_PlanBase.endpoint_weights exactly, e.g.
    # {"/products": 60, "/search": 25, "/checkout": 15}. Omitting it means
    # uniform dispatch across `endpoints`, unchanged from before this field
    # existed. Only structural typing lives here -- the authoritative
    # semantic checks (every selected endpoint has exactly one positive
    # weight) live solely on TestPlan's own validator and are reused, never
    # duplicated, by intent_compiler.compile_intent(). The intent layer
    # never invents or infers a weight the caller didn't supply.
    endpoint_weights: Optional[Dict[str, float]] = None


class BusinessFlow(BaseModel):
    """A named multi-step user journey (browse -> add_cart -> checkout).
    Structurally represented so the AI layer has somewhere to put this
    intent, but resolving a business flow into concrete endpoints is not
    implemented -- the compiler always rejects an intent that carries one
    with a structured, explicit INVALID result. See Phase F of
    ai_intent_architecture.md."""

    name: Optional[str] = None
    steps: List[str] = Field(min_length=1)


class SuccessCriteria(BaseModel):
    """Mirrors app/schemas/test_plan.py::Thresholds exactly (same field
    names, same constraints) so a fully-specified intent maps 1:1. Both
    fields are optional here -- the compiler applies documented deterministic
    defaults for whichever is missing (see intent_compiler.DEFAULT_*)."""

    p95_latency_ms: Optional[PositiveInt] = None
    error_rate: Optional[float] = Field(default=None, ge=0, le=1)


class ConfidenceInfo(BaseModel):
    """Advisory metadata from the AI interpretation layer. The compiler
    NEVER reads this field to make a decision -- confidence cannot
    substitute for a required field, and a high confidence score cannot
    override backend validation. It exists purely for UI/observability
    (e.g. surfacing "the AI was unsure about this")."""

    overall: Optional[float] = Field(default=None, ge=0, le=1)


class ClarificationItem(BaseModel):
    """One machine-readable ambiguity. `field` is a dotted path into
    UniversalPerformanceIntent (e.g. 'load_profile.concurrent_users') so a
    UI can highlight exactly what's missing instead of parsing a string."""

    field: str
    question: str


class UniversalPerformanceIntent(BaseModel):
    """The AI-facing contract. Anything after this model is deterministic,
    validated backend logic (app/services/intent_compiler.py) -- no field
    here is ever turned into k6 JavaScript, a shell command, or a database
    operation directly."""

    objective: Optional[str] = None
    test_type: Optional[TestType] = None
    load_profile: LoadProfile = Field(default_factory=LoadProfile)
    duration: Optional[str] = None
    target_scope: TargetScope = Field(default_factory=TargetScope)
    business_flow: Optional[BusinessFlow] = None
    success_criteria: SuccessCriteria = Field(default_factory=SuccessCriteria)
    schedule: Optional[dict] = None
    confidence: Optional[ConfidenceInfo] = None
    clarifications_needed: List[ClarificationItem] = Field(default_factory=list)

    @field_validator("business_flow", mode="before")
    @classmethod
    def _coerce_business_flow_shorthand(cls, v):
        """Accepts the shorthand `"business_flow": ["browse", "checkout"]`
        in addition to the full `{"name": ..., "steps": [...]}` form -- both
        appear in the illustrative examples this schema was drafted from."""
        if isinstance(v, list):
            return {"steps": v}
        return v

    @field_validator("duration")
    @classmethod
    def _validate_duration_syntax(cls, v: Optional[str]) -> Optional[str]:
        import re

        if v is not None and not re.match(DURATION_PATTERN, v):
            raise ValueError(f"malformed duration: {v!r}")
        return v


class IntentCompilationResponse(BaseModel):
    """Response body for POST /api/v1/intents/compile. Compilation only --
    this never triggers execution. A READY response's `test_plan` can be
    handed, unmodified, to POST /api/v1/runs as the inline `plan` to
    actually run it -- that confirmation step is deliberately left to the
    caller (see Phase G of ai_intent_architecture.md)."""

    status: IntentStatus
    intent: UniversalPerformanceIntent
    test_plan: Optional[TestPlan] = None
    clarifications_needed: List[ClarificationItem] = Field(default_factory=list)
    rejection_code: Optional[str] = None
    rejection_reason: Optional[str] = None
