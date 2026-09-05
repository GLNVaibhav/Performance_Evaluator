from typing import Annotated, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, PositiveInt, field_validator, model_validator

from app.schemas.enums import ObjectiveType, TestType

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


class TargetConfig(BaseModel):
    """Where the plan's endpoints are resolved against. Auth is deliberately
    out of scope for Phase 1 (no target requires it yet)."""

    base_url: str
