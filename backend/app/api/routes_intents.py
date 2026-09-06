"""Additive API boundary for intent compilation. Deliberately separate from
POST /api/v1/runs: this endpoint only translates a UniversalPerformanceIntent
into a TestPlan (or a structured clarification/rejection) and returns it --
it never persists a run, never touches the DB, and never reaches
RunService or PerformanceEngine. A caller wanting to execute a READY result
takes its `test_plan` and POSTs it, unmodified, as the inline `plan` on the
existing `POST /api/v1/runs` -- execution is a separate, explicit action so
a UI can show the compiled plan for confirmation first.
"""

from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import LLM_KNOWN_ENDPOINTS, MAX_DURATION_S, MAX_VUS
from app.schemas.intent import IntentCompilationResponse, UniversalPerformanceIntent
from app.services.intent_compiler import compile_intent
from app.services.intent_interpreter import InterpretationResult
from app.services.interpreter_provider import get_intent_interpreter

router = APIRouter(prefix="/intents", tags=["intents"])


class KnownEndpointsResponse(BaseModel):
    """The closed set app/services/llm_intent_interpreter.py enforces
    endpoint selection against (see its containment check) -- exposed
    read-only so a frontend can show what's actually testable without
    hardcoding or guessing the same list independently."""

    endpoints: List[str]


@router.get("/known-endpoints", response_model=KnownEndpointsResponse)
def known_endpoints_endpoint() -> KnownEndpointsResponse:
    return KnownEndpointsResponse(endpoints=LLM_KNOWN_ENDPOINTS)


class WorkloadLimitsResponse(BaseModel):
    """The SAME MAX_VUS/MAX_DURATION_S app/services/workload_limits.py
    authoritatively enforces (Session 3, read-only, additive) -- exposed
    so a caller (human or LLM proposing an intent) can know the safety
    envelope UP FRONT rather than discovering it only after a rejected
    /compile call. Purely informational: this endpoint enforces nothing
    itself, and returning a value here never bypasses or duplicates the
    real enforcement, which stays exactly where it already was."""

    max_vus: int
    max_duration_s: int


@router.get("/workload-limits", response_model=WorkloadLimitsResponse)
def workload_limits_endpoint() -> WorkloadLimitsResponse:
    return WorkloadLimitsResponse(max_vus=MAX_VUS, max_duration_s=MAX_DURATION_S)


@router.post("/compile", response_model=IntentCompilationResponse)
def compile_intent_endpoint(intent: UniversalPerformanceIntent) -> IntentCompilationResponse:
    return compile_intent(intent)


class InterpretRequest(BaseModel):
    """Route-local request model -- deliberately not added to
    app/schemas/intent.py, which stays untouched (this is not a
    UniversalPerformanceIntent-family type, just this one endpoint's
    input)."""

    user_input: str


@router.post("/interpret", response_model=InterpretationResult)
def interpret_intent_endpoint(request: InterpretRequest) -> InterpretationResult:
    """Natural language -> InterpretationResult, ONLY. Deliberately does
    NOT call compile_intent() -- POST /intents/compile remains the sole,
    authoritative path from a structured intent to a TestPlan (or
    clarification/rejection). This endpoint never creates a run, never
    touches RunService or PerformanceEngine, and never executes anything;
    it exists purely to turn language into the same
    UniversalPerformanceIntent shape a human (or a hand-authored request)
    could already submit to /compile."""
    interpreter = get_intent_interpreter()
    return interpreter.interpret(request.user_input)


class InterpretAndCompileResponse(BaseModel):
    """Convenience composition, not a new authority. Exactly:
    interpret() -> if an intent exists -> compile_intent(). No compiler
    logic is duplicated -- compilation is still the same, single
    compile_intent() call every other path already uses."""

    interpretation: InterpretationResult
    compilation: Optional[IntentCompilationResponse] = None


@router.post("/interpret-and-compile", response_model=InterpretAndCompileResponse)
def interpret_and_compile_endpoint(request: InterpretRequest) -> InterpretAndCompileResponse:
    interpreter = get_intent_interpreter()
    interpretation = interpreter.interpret(request.user_input)
    compilation = compile_intent(interpretation.intent) if interpretation.intent is not None else None
    return InterpretAndCompileResponse(interpretation=interpretation, compilation=compilation)
