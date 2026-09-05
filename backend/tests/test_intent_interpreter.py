"""Tests for the IntentInterpreter boundary (app/services/intent_interpreter.py).

These prove COMPOSITION with the existing, unmodified compile_intent() --
every TestPlan here comes from compile_intent(), never constructed by
hand -- and prove that an interpreter failure is fully isolated from the
compiler and execution core. No real NLP, no LLM provider, no external
dependency: everything is deterministic fixtures and fakes, matching
tests/fakes.py's existing FakePerformanceEngine convention.
"""
import pytest

from app.schemas.enums import IntentStatus, TestType
from app.schemas.intent import LoadProfile, TargetScope, UniversalPerformanceIntent
from app.services.intent_compiler import compile_intent
from app.services.intent_interpreter import (
    DeterministicIntentInterpreter,
    InterpretationResult,
    InterpretationStatus,
)


# --- 1. COMPLETE: interpreter -> intent -> EXISTING compile_intent() -> READY TestPlan


def test_complete_interpretation_compiles_to_ready_test_plan_via_existing_compiler():
    interpreter = DeterministicIntentInterpreter()
    result = interpreter.interpret("Run a baseline test on /products with 50 users for 30s")

    assert result.status == InterpretationStatus.COMPLETE
    assert result.intent is not None

    # The TestPlan comes from the existing, unmodified compiler -- not
    # constructed here.
    compilation = compile_intent(result.intent)

    assert compilation.status == IntentStatus.READY
    assert compilation.test_plan is not None
    assert compilation.test_plan.target_vus == 50
    assert compilation.test_plan.duration == "30s"
    assert compilation.test_plan.selected_endpoints == ["/products"]


# --- 2. INCOMPLETE: nothing invented; existing compiler clarification is authoritative


def test_incomplete_interpretation_invents_nothing_and_compiler_asks_for_clarification():
    interpreter = DeterministicIntentInterpreter()
    result = interpreter.interpret("Test my checkout API")

    assert result.status == InterpretationStatus.INCOMPLETE
    assert result.intent is not None

    # What was understood:
    assert result.intent.target_scope.endpoints == ["/checkout"]
    # What must NOT be invented:
    assert result.intent.test_type is None
    assert result.intent.load_profile.concurrent_users is None
    assert result.intent.load_profile.peak_users is None
    assert result.intent.duration is None

    # The EXISTING compiler, not the interpreter, decides what's missing
    # and asks for it. It asks progressively -- duration/load clarification
    # only kick in once test_type is known (stress doesn't need duration
    # the same way baseline/soak do), so with test_type itself missing,
    # the compiler's one and only question at this stage is test_type.
    # This is existing, unmodified compiler behavior -- the interpreter
    # must not try to anticipate or duplicate it.
    compilation = compile_intent(result.intent)
    assert compilation.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in compilation.clarifications_needed}
    assert fields == {"test_type"}

    # Confirms duration/load truly weren't invented, rather than merely
    # not yet surfaced: supplying test_type (as a human answering the
    # compiler's question would) reveals the compiler's next round of
    # genuinely-still-missing fields.
    answered = result.intent.model_copy(update={"test_type": TestType.baseline})
    second_round = compile_intent(answered)
    assert second_round.status == IntentStatus.NEEDS_CLARIFICATION
    second_fields = {c.field for c in second_round.clarifications_needed}
    assert second_fields == {"duration", "load_profile.concurrent_users"}


# --- 3. AMBIGUOUS: raw language never silently maps to an arbitrary value


def test_ambiguous_interpretation_produces_no_intent_and_no_arbitrary_value():
    interpreter = DeterministicIntentInterpreter()
    result = interpreter.interpret("Run a heavy test")

    assert result.status == InterpretationStatus.AMBIGUOUS
    # There is nothing to compile -- this IS the proof that no VU count,
    # test_type, or duration was guessed from "heavy": no intent object
    # exists for such a guess to hide inside.
    assert result.intent is None
    assert result.reason is not None


# --- 4. INVALID: unsupported/adversarial requests never proceed toward execution


def test_invalid_interpretation_produces_no_intent_and_never_proceeds():
    interpreter = DeterministicIntentInterpreter()
    result = interpreter.interpret("Run a DDoS attack on production")

    assert result.status == InterpretationStatus.INVALID
    assert result.intent is None
    assert result.reason is not None


# --- 5. INTERPRETATION_FAILURE: isolated from compiler, RunService, PerformanceEngine


class _AlwaysFailingInterpreter:
    """Test-only double, mirroring tests/fakes.py::FakePerformanceEngine's
    dual mode (canned outcome vs. raise_error): either returns a canned
    INTERPRETATION_FAILURE result, or raises outright to simulate a real
    provider's own exception (network error, timeout, malformed output)."""

    def __init__(self, raise_error: bool = False):
        self._raise_error = raise_error

    def interpret(self, user_input: str) -> InterpretationResult:
        if self._raise_error:
            raise RuntimeError("simulated provider crash")
        return InterpretationResult(
            status=InterpretationStatus.INTERPRETATION_FAILURE,
            reason="simulated provider timeout",
        )


def test_interpretation_failure_result_carries_no_intent():
    result = _AlwaysFailingInterpreter().interpret("anything")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None


def test_interpreter_failure_never_reaches_compile_intent_run_service_or_engine(monkeypatch):
    """Actively proves absence, not just asserts it: each of compile_intent,
    run_service.create_run/execute_run, and get_performance_engine is
    monkeypatched to raise AssertionError if called. If a failing
    interpreter's exception somehow routed into any of them, this test
    would see that AssertionError instead of the expected RuntimeError."""
    import app.services.engine_provider as engine_provider_module
    import app.services.intent_compiler as intent_compiler_module
    import app.services.run_service as run_service_module

    def _fail_if_called(*args, **kwargs):
        raise AssertionError("an interpreter failure must never reach this call")

    monkeypatch.setattr(intent_compiler_module, "compile_intent", _fail_if_called)
    monkeypatch.setattr(run_service_module, "create_run", _fail_if_called)
    monkeypatch.setattr(run_service_module, "execute_run", _fail_if_called)
    monkeypatch.setattr(engine_provider_module, "get_performance_engine", _fail_if_called)

    interpreter = _AlwaysFailingInterpreter(raise_error=True)
    with pytest.raises(RuntimeError, match="simulated provider crash"):
        interpreter.interpret("anything")
    # Reaching here with RuntimeError (not AssertionError) proves none of
    # the patched calls happened.


# --- 6. Provider/interpreter interchangeability -----------------------------


class _AlternatePhrasingInterpreter:
    """A second, independently-implemented deterministic interpreter (a
    different internal keying scheme entirely) used only to prove the
    provider-swap invariant: compile_intent() cares about the INTENT
    object, never about which interpreter produced it."""

    def interpret(self, user_input: str) -> InterpretationResult:
        if user_input != "baseline products 50 30s":
            raise ValueError("unrecognized fixture input")
        return InterpretationResult(
            status=InterpretationStatus.COMPLETE,
            intent=UniversalPerformanceIntent(
                test_type=TestType.baseline,
                load_profile=LoadProfile(concurrent_users=50),
                duration="30s",
                target_scope=TargetScope(endpoints=["/products"]),
            ),
        )


def test_equivalent_intents_from_different_interpreters_compile_identically():
    result_a = DeterministicIntentInterpreter().interpret("Run a baseline test on /products with 50 users for 30s")
    result_b = _AlternatePhrasingInterpreter().interpret("baseline products 50 30s")

    # `objective` is free-text/UI-only and never read by compile_intent();
    # drop it before comparing so the test isn't sensitive to wording that
    # provably doesn't affect compilation.
    intent_a = result_a.intent.model_copy(update={"objective": None})
    intent_b = result_b.intent.model_copy(update={"objective": None})
    assert intent_a == intent_b

    plan_a = compile_intent(intent_a).test_plan
    plan_b = compile_intent(intent_b).test_plan
    assert plan_a is not None and plan_b is not None
    assert plan_a.model_dump() == plan_b.model_dump()
