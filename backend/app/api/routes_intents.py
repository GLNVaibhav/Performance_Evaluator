"""Additive API boundary for intent compilation. Deliberately separate from
POST /api/v1/runs: this endpoint only translates a UniversalPerformanceIntent
into a TestPlan (or a structured clarification/rejection) and returns it --
it never persists a run, never touches the DB, and never reaches
RunService or PerformanceEngine. A caller wanting to execute a READY result
takes its `test_plan` and POSTs it, unmodified, as the inline `plan` on the
existing `POST /api/v1/runs` -- execution is a separate, explicit action so
a UI can show the compiled plan for confirmation first.
"""

from fastapi import APIRouter

from app.schemas.intent import IntentCompilationResponse, UniversalPerformanceIntent
from app.services.intent_compiler import compile_intent

router = APIRouter(prefix="/intents", tags=["intents"])


@router.post("/compile", response_model=IntentCompilationResponse)
def compile_intent_endpoint(intent: UniversalPerformanceIntent) -> IntentCompilationResponse:
    return compile_intent(intent)
