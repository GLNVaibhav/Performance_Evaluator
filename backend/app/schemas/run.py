from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from app.schemas.enums import RunState
from app.schemas.test_plan import TargetConfig, TestPlan


class BuildMetadata(BaseModel):
    """Phase 11: optional build/commit metadata the CLIENT may attach to a
    new run so the result can be traced to the exact version of the system
    under test. Never inferred server-side: any field the caller omits or
    leaves blank is stored as the literal "UNKNOWN" — a wrong guess is
    worse than an honest unknown. Values are free-form short labels (git
    SHAs, image tags, environment names); they are never interpreted by
    the execution path and existing runs (created before this existed)
    remain valid with UNKNOWN defaults."""

    # Provenance labels, not a data channel: every label is capped at 128
    # chars at the schema level so no construction path (HTTP request or
    # otherwise) can store an unbounded value. RunCreateRequest re-checks
    # the bound as defense in depth.
    build_id: str = Field(default="", max_length=128)
    git_commit: str = Field(default="", max_length=128)
    application_version: str = Field(default="", max_length=128)
    environment: str = Field(default="", max_length=128)
    deployment_id: str = Field(default="", max_length=128)

    def resolved(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in self.model_dump().items():
            text = (value or "").strip()
            out[key] = text if text else "UNKNOWN"
        return out


class RunCreateRequest(BaseModel):
    """Phase 1 accepts either an inline validated TestPlan, or a reference
    to one of the hardcoded demo plans in demo_plans/. LLM planning is not
    a dependency for either path.

    Execution-bridge envelope (additive, optional): a Convex control plane
    may attach a `correlation_id` and a `submitted_by` label. Neither is a
    second run identifier — the run_id remains authoritative here; the
    correlation id is echoed into the plan's assumptions so a submission is
    traceable end-to-end. Both are ignored by the execution path itself.
    """

    plan: Optional[TestPlan] = None
    plan_id: Optional[str] = None
    target: TargetConfig
    correlation_id: Optional[str] = None
    submitted_by: Optional[str] = None
    metadata: Optional[BuildMetadata] = Field(default=None)

    @model_validator(mode="after")
    def _metadata_length_bounds(self) -> "RunCreateRequest":
        """Metadata is provenance, not a data channel: cap each label so a
        run row cannot grow without bound."""
        if self.metadata is not None:
            for key, value in self.metadata.model_dump().items():
                if len((value or "")) > 128:
                    raise ValueError(f"metadata.{key} exceeds 128 characters")
        return self

    @model_validator(mode="after")
    def _exactly_one_plan_source(self) -> "RunCreateRequest":
        if bool(self.plan) == bool(self.plan_id):
            raise ValueError("provide exactly one of 'plan' or 'plan_id'")
        return self

    @model_validator(mode="after")
    def _echo_correlation_id_into_assumptions(self) -> "RunCreateRequest":
        """Correlation traceability without a schema change: the TestPlan
        model is the frozen central contract, so the correlation id rides in
        `assumptions` — visible in GET /runs/{id}/result's plan, deterministic
        end-to-end, and never treated as a second identifier."""
        if self.plan is not None and self.correlation_id:
            marker = f"correlation_id: {self.correlation_id}"
            if marker not in self.plan.assumptions:
                self.plan.assumptions = [*self.plan.assumptions, marker]
        return self


class RunCreateResponse(BaseModel):
    run_id: str
    status: RunState


class RunStatusResponse(BaseModel):
    run_id: str
    status: RunState
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error_message: Optional[str] = None
