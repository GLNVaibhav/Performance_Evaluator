"""HTTP-level tests for POST /api/v1/intents/interpret and
/interpret-and-compile. No real LLM call -- the wired interpreter
(app/services/interpreter_provider.py) is monkeypatched to a small fake
implementing the same IntentInterpreter Protocol, so these tests prove the
ROUTE/composition wiring, not the LLM pipeline itself (that's
tests/test_llm_intent_interpreter.py).
"""
from app.services import interpreter_provider
from app.services.intent_interpreter import InterpretationResult, InterpretationStatus
from app.schemas.intent import UniversalPerformanceIntent


class _FakeInterpreter:
    def __init__(self, result: InterpretationResult):
        self._result = result

    def interpret(self, user_input: str) -> InterpretationResult:
        return self._result


def _use_fake_interpreter(monkeypatch, result: InterpretationResult) -> None:
    monkeypatch.setattr(interpreter_provider, "_interpreter", _FakeInterpreter(result))


def test_interpret_endpoint_returns_interpretation_result_shape(client, monkeypatch):
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 20},
            "duration": "15s",
            "target_scope": {"endpoints": ["/products"]},
        }
    )
    _use_fake_interpreter(monkeypatch, InterpretationResult(status=InterpretationStatus.COMPLETE, intent=intent))

    resp = client.post("/api/v1/intents/interpret", json={"user_input": "20 users on products for 15s"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "COMPLETE"
    assert body["intent"]["target_scope"]["endpoints"] == ["/products"]


def test_interpret_endpoint_never_calls_compile_intent(client, monkeypatch):
    """/interpret must return the raw InterpretationResult only -- no
    test_plan, no compilation status, ever."""
    import app.services.intent_compiler as intent_compiler_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("/intents/interpret must never call compile_intent()")

    monkeypatch.setattr(intent_compiler_module, "compile_intent", _fail_if_called)

    intent = UniversalPerformanceIntent.model_validate({"test_type": "baseline"})
    _use_fake_interpreter(monkeypatch, InterpretationResult(status=InterpretationStatus.COMPLETE, intent=intent))

    resp = client.post("/api/v1/intents/interpret", json={"user_input": "anything"})
    assert resp.status_code == 200
    assert "test_plan" not in resp.json()


def test_interpret_endpoint_never_creates_a_run(client, monkeypatch, db_session):
    from app.storage import repository

    runs_before = db_session.query(repository.TestRunRecord).count()

    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": {"endpoints": ["/products"]},
        }
    )
    _use_fake_interpreter(monkeypatch, InterpretationResult(status=InterpretationStatus.COMPLETE, intent=intent))
    client.post("/api/v1/intents/interpret", json={"user_input": "anything"})

    assert db_session.query(repository.TestRunRecord).count() == runs_before


def test_interpret_and_compile_composes_to_ready(client, monkeypatch):
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 20},
            "duration": "15s",
            "target_scope": {"endpoints": ["/products"]},
            "success_criteria": {"p95_latency_ms": 1000, "error_rate": 0.05},
        }
    )
    _use_fake_interpreter(monkeypatch, InterpretationResult(status=InterpretationStatus.COMPLETE, intent=intent))

    resp = client.post(
        "/api/v1/intents/interpret-and-compile", json={"user_input": "20 users on products for 15s"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["interpretation"]["status"] == "COMPLETE"
    assert body["compilation"]["status"] == "READY"
    assert body["compilation"]["test_plan"]["target_vus"] == 20


def test_interpret_and_compile_skips_compilation_when_ambiguous(client, monkeypatch):
    import app.services.intent_compiler as intent_compiler_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("must not compile an AMBIGUOUS interpretation (no intent exists)")

    monkeypatch.setattr(intent_compiler_module, "compile_intent", _fail_if_called)

    _use_fake_interpreter(
        monkeypatch,
        InterpretationResult(status=InterpretationStatus.AMBIGUOUS, intent=None, reason="too vague"),
    )

    resp = client.post("/api/v1/intents/interpret-and-compile", json={"user_input": "make it heavy"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["interpretation"]["status"] == "AMBIGUOUS"
    assert body["compilation"] is None


def test_interpret_and_compile_never_creates_a_run_even_when_ready(client, monkeypatch, db_session):
    """The compile step happens, but execution still requires the separate,
    explicit POST /runs call -- this endpoint stops at compilation."""
    from app.storage import repository

    runs_before = db_session.query(repository.TestRunRecord).count()

    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": {"endpoints": ["/products"]},
        }
    )
    _use_fake_interpreter(monkeypatch, InterpretationResult(status=InterpretationStatus.COMPLETE, intent=intent))
    resp = client.post("/api/v1/intents/interpret-and-compile", json={"user_input": "anything"})
    assert resp.json()["compilation"]["status"] == "READY"

    assert db_session.query(repository.TestRunRecord).count() == runs_before
