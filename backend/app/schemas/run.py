from datetime import datetime
from typing import Optional

from pydantic import BaseModel, model_validator

from app.schemas.enums import RunState
from app.schemas.test_plan import TargetConfig, TestPlan


class RunCreateRequest(BaseModel):
    """Phase 1 accepts either an inline validated TestPlan, or a reference
    to one of the hardcoded demo plans in demo_plans/. LLM planning is not
    a dependency for either path."""

    plan: Optional[TestPlan] = None
    plan_id: Optional[str] = None
    target: TargetConfig

    @model_validator(mode="after")
    def _exactly_one_plan_source(self) -> "RunCreateRequest":
        if bool(self.plan) == bool(self.plan_id):
            raise ValueError("provide exactly one of 'plan' or 'plan_id'")
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
