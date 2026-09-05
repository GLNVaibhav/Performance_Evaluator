"""Tests for LLMIntentInterpreter (app/services/llm_intent_interpreter.py).

No real LLM API key is required or used anywhere in this file --
httpx.MockTransport (part of httpx, already a dependency; no new test
dependency) is injected as the interpreter's HTTP transport, so every test
here exercises the REAL request-building, JSON-parsing, and
UniversalPerformanceIntent-validation code, deterministically, offline.

Tests 1-6 and 9 prove the PIPELINE (parsing/validation/failure-mapping)
behaves correctly for a given provider response -- they cannot prove a
real model always chooses to respond that way (that's a prompt-design
claim, verified separately via the live demonstration in this task's
report, not a deterministic unit test). Tests 7-8 prove architectural
composition and isolation.
"""
import httpx
import pytest

from app.schemas.enums import IntentStatus, TestType
from app.services.intent_compiler import compile_intent
from app.services.intent_interpreter import InterpretationStatus
from app.services.llm_intent_interpreter import LLMIntentInterpreter


def _mock_client(content: str, status_code: int = 200) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            json={"choices": [{"message": {"content": content}}]},
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def _raising_client(exc: Exception) -> httpx.Client:
    def handler(request: httpx.Request):
        raise exc

    return httpx.Client(transport=httpx.MockTransport(handler))


def _interpreter(content: str, **kwargs) -> LLMIntentInterpreter:
    return LLMIntentInterpreter(api_key="test-key", http_client=_mock_client(content), **kwargs)


# --- Test 1: successful structured interpretation ---------------------------


def test_complete_interpretation_from_mocked_provider():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "objective": "Evaluate ecommerce API performance",
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 30, "peak_users": null},
        "duration": "20s",
        "target_scope": {
          "endpoints": ["/products", "/products/{product_id}", "/checkout"],
          "endpoint_weights": {"/products": 60, "/products/{product_id}": 25, "/checkout": 15}
        },
        "success_criteria": {"p95_latency_ms": 800, "error_rate": null}
      },
      "reason": null
    }"""
    interpreter = _interpreter(
        content, available_endpoints=["/products", "/products/{product_id}", "/categories", "/checkout"]
    )
    result = interpreter.interpret(
        "Simulate 30 users on my ecommerce API for 20 seconds. Most should browse products, "
        "some should view product details and a few should checkout. I need p95 latency below 800ms."
    )

    assert result.status == InterpretationStatus.COMPLETE
    assert result.intent is not None
    assert result.intent.test_type == TestType.baseline
    assert result.intent.load_profile.concurrent_users == 30
    assert result.intent.duration == "20s"
    assert result.intent.target_scope.endpoints == ["/products", "/products/{product_id}", "/checkout"]
    assert result.intent.success_criteria.p95_latency_ms == 800


# --- Test 2: incomplete request -- nulls preserved, nothing invented -------


def test_incomplete_interpretation_preserves_nulls():
    content = """{
      "status": "INCOMPLETE",
      "intent": {
        "objective": "Test checkout API",
        "test_type": null,
        "load_profile": {"concurrent_users": null, "peak_users": null},
        "duration": null,
        "target_scope": {"endpoints": ["/checkout"], "endpoint_weights": null},
        "success_criteria": {"p95_latency_ms": null, "error_rate": null}
      },
      "reason": "endpoint recognized; test_type, users, and duration were not specified"
    }"""
    interpreter = _interpreter(content, available_endpoints=["/products", "/checkout"])
    result = interpreter.interpret("Test my checkout API")

    assert result.status == InterpretationStatus.INCOMPLETE
    assert result.intent.target_scope.endpoints == ["/checkout"]
    assert result.intent.test_type is None
    assert result.intent.load_profile.concurrent_users is None
    assert result.intent.duration is None


# --- Test 3: ambiguous request ----------------------------------------------


def test_ambiguous_interpretation_carries_no_intent():
    content = """{
      "status": "AMBIGUOUS",
      "intent": null,
      "reason": "'extremely heavy' does not map to any defined test_type or load value"
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("Make the API extremely heavy")

    assert result.status == InterpretationStatus.AMBIGUOUS
    assert result.intent is None
    assert result.reason is not None


# --- Test 4: provider timeout/connection failure ----------------------------


def test_provider_timeout_maps_to_interpretation_failure():
    interpreter = LLMIntentInterpreter(
        api_key="test-key",
        http_client=_raising_client(httpx.TimeoutException("simulated timeout")),
    )
    result = interpreter.interpret("Test my API with 10 users for 10 seconds")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None
    assert "timeout" in result.reason.lower() or "simulated" in result.reason.lower()


def test_provider_connection_error_maps_to_interpretation_failure():
    interpreter = LLMIntentInterpreter(
        api_key="test-key",
        http_client=_raising_client(httpx.ConnectError("simulated connection refused")),
    )
    result = interpreter.interpret("Test my API")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None


def test_provider_error_status_maps_to_interpretation_failure():
    """Invalid API key / rate limiting / provider unavailable all surface
    as a non-2xx HTTP status, which raise_for_status() turns into an
    exception this layer catches."""
    interpreter = LLMIntentInterpreter(
        api_key="test-key",
        http_client=_mock_client('{"error": "invalid_api_key"}', status_code=401),
    )
    result = interpreter.interpret("Test my API")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None


# --- Test 5: malformed JSON from provider -----------------------------------


def test_malformed_json_maps_to_interpretation_failure():
    interpreter = _interpreter("this is not { valid json at all")
    result = interpreter.interpret("Test my API with 10 users for 10 seconds")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None
    assert "json" in result.reason.lower()


# --- Test 6: schema-invalid provider output ---------------------------------


def test_schema_invalid_wrong_type_maps_to_interpretation_failure():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": "fifty"},
        "duration": "30s",
        "target_scope": {"endpoints": ["/products"]}
      }
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("Fifty users for 30 seconds on products")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None


def test_schema_invalid_unsupported_test_type_maps_to_interpretation_failure():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "load",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "target_scope": {"endpoints": ["/products"]}
      }
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("Load test with 10 users")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None


def test_schema_invalid_malformed_duration_maps_to_interpretation_failure():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "thirty seconds",
        "target_scope": {"endpoints": ["/products"]}
      }
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("10 users for thirty seconds on products")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE


def test_hallucinated_status_maps_to_interpretation_failure():
    content = '{"status": "SUPER_READY", "intent": null}'
    interpreter = _interpreter(content)
    result = interpreter.interpret("anything")
    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE


def test_model_claiming_interpretation_failure_itself_is_not_trusted():
    """The model must not be able to claim the one status reserved for
    THIS layer's own provider-failure detection."""
    content = '{"status": "INTERPRETATION_FAILURE", "intent": null, "reason": "trust me"}'
    interpreter = _interpreter(content)
    result = interpreter.interpret("anything")
    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert "illegally" in result.reason


# --- Test 7: architecture composition with the REAL compile_intent() -------


def test_complete_result_composes_with_real_compile_intent_to_ready():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 20},
        "duration": "15s",
        "target_scope": {"endpoints": ["/products"]},
        "success_criteria": {"p95_latency_ms": 1000, "error_rate": 0.05}
      }
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("20 users on products for 15 seconds, p95 under 1000ms, error rate under 5%")

    assert result.status == InterpretationStatus.COMPLETE
    # TestPlan comes from the REAL, unmodified compiler -- never hand-built.
    compiled = compile_intent(result.intent)
    assert compiled.status == IntentStatus.READY
    assert compiled.test_plan.target_vus == 20
    assert compiled.test_plan.duration == "15s"


def test_incomplete_result_composes_with_real_compile_intent_to_needs_clarification():
    content = """{
      "status": "INCOMPLETE",
      "intent": {
        "target_scope": {"endpoints": ["/checkout"]}
      },
      "reason": "missing test_type, users, duration"
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("Test my checkout API")

    assert result.status == InterpretationStatus.INCOMPLETE
    compiled = compile_intent(result.intent)
    assert compiled.status == IntentStatus.NEEDS_CLARIFICATION
    assert len(compiled.clarifications_needed) > 0


# --- Test 8: execution isolation --------------------------------------------


def test_interpret_never_touches_run_service_performance_engine_or_k6(monkeypatch):
    import app.services.engine_provider as engine_provider_module
    import app.services.run_service as run_service_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("LLMIntentInterpreter.interpret() must never reach this")

    monkeypatch.setattr(run_service_module, "create_run", _fail_if_called)
    monkeypatch.setattr(run_service_module, "execute_run", _fail_if_called)
    monkeypatch.setattr(engine_provider_module, "get_performance_engine", _fail_if_called)

    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "target_scope": {"endpoints": ["/products"]}
      }
    }"""
    interpreter = _interpreter(content)
    result = interpreter.interpret("10 users on products for 10 seconds")

    assert result.status == InterpretationStatus.COMPLETE  # completed normally, nothing tripped


# --- Test 9: endpoint containment --------------------------------------------


def test_endpoint_outside_known_set_is_rejected_not_passed_through():
    """Proves hallucination containment: even if the model returns an
    endpoint outside the configured known set, it can never reach a
    COMPLETE/INCOMPLETE result -- it is safely mapped to
    INTERPRETATION_FAILURE instead of silently trusted."""
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "target_scope": {"endpoints": ["/admin/delete-everything"]}
      }
    }"""
    interpreter = _interpreter(content, available_endpoints=["/products", "/categories", "/checkout"])
    result = interpreter.interpret("10 users hitting the admin panel")

    assert result.status == InterpretationStatus.INTERPRETATION_FAILURE
    assert result.intent is None
    assert "/admin/delete-everything" in result.reason


def test_endpoint_within_known_set_passes_through_normally():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "target_scope": {"endpoints": ["/products", "/checkout"]}
      }
    }"""
    interpreter = _interpreter(content, available_endpoints=["/products", "/categories", "/checkout"])
    result = interpreter.interpret("10 users browsing products then checking out")

    assert result.status == InterpretationStatus.COMPLETE
    assert result.intent.target_scope.endpoints == ["/products", "/checkout"]


def test_no_available_endpoints_configured_skips_containment_check():
    content = """{
      "status": "COMPLETE",
      "intent": {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "target_scope": {"endpoints": ["/anything"]}
      }
    }"""
    interpreter = _interpreter(content, available_endpoints=[])
    result = interpreter.interpret("10 users on /anything")
    assert result.status == InterpretationStatus.COMPLETE
