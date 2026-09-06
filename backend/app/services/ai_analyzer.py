"""AIResultAnalyzer: evidence-grounded, OPTIONAL interpretation of an
already-complete deterministic result. Mirrors
app/services/llm_intent_interpreter.py's exact architecture and
discipline (Protocol + concrete OpenAI-compatible implementation, plain
httpx, same LLM_* config, same "never trust the raw provider response"
pipeline) -- deliberately, since that module is this project's own
reviewed precedent for "how an LLM boundary behaves in this codebase."

ABSOLUTE RULE (mirrors llm_intent_interpreter.py's own): this class
produces ONLY an AIAnalysis, or None. It never:

  - computes a metric, percentile, rate, or ranking itself (every number
    it can reference already exists in the AIAnalysisInput bundle it was
    given -- Statistics/FailureLocalization/TestPlan, all pre-computed),
  - modifies the deterministic result (TestResult, Statistics,
    FailureLocalization, threshold_status are never touched -- this class
    has no write access to any of them),
  - executes arbitrary code (the model's output is parsed as JSON into a
    fixed schema, `AIAnalysis.model_validate()`, and nothing else --
    never `eval`/`exec`, never a code path the response text can steer),
  - receives a secret (AIAnalysisInput has no field that could hold one --
    TestPlan never carries auth, per app/schemas/test_plan.py::
    TargetConfig's docstring; only `target_base_url`, a plain non-secret
    URL string, is included).

Required pipeline (never trust the raw provider response -- identical
shape to llm_intent_interpreter.py's):

    LLM HTTP response
        -> JSON extraction (strip an optional markdown code fence)
        -> json.loads                      -> malformed JSON -> None
        -> AIAnalysis.model_validate(parsed)  -- the EXISTING schema, not
           a duplicate one -- invalid field/type/value -> None
        -> AIAnalysis

No value is ever invented or silently repaired at any stage -- any
failure at any step returns `None` (analysis simply unavailable), never a
best-effort guess and never a crash. See docs/performance_engine_interface.md's
AI section for the full failure-handling matrix.
"""
from __future__ import annotations

import json
from typing import Optional, Protocol

import httpx
from pydantic import BaseModel, ValidationError

from app.core.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_S
from app.schemas.enums import ResultClassification
from app.schemas.test_plan import TestPlan
from app.schemas.test_result import AIAnalysis, FailureLocalization, Statistics


class AIAnalysisInput(BaseModel):
    """The complete, sanitized evidence bundle handed to the analyzer --
    structurally incapable of carrying a secret (no field here could hold
    one; `plan: TestPlan` itself has no auth field at all -- see
    app/schemas/test_plan.py::TargetConfig's docstring). This is the ONLY
    input `AIResultAnalyzer.analyze()` accepts; it never reaches into the
    database, the run record, or TargetConfig.auth itself."""

    run_id: str
    target_base_url: Optional[str] = None
    plan: Optional[TestPlan] = None
    threshold_status: ResultClassification
    statistics: Statistics
    failure_localization: FailureLocalization


class AIAnalyzer(Protocol):
    def analyze(self, evidence: AIAnalysisInput) -> Optional[AIAnalysis]:
        """Returns None whenever analysis is unavailable for ANY reason
        (provider unreachable, malformed response, schema-invalid
        response) -- never raises. The deterministic result is complete
        and correct with or without this method ever succeeding."""
        ...


_SYSTEM_PROMPT = """\
You analyze the results of an already-completed, already-decided \
performance test. You do not run tests, generate code, or calculate any \
metric -- every number you might reference is ALREADY computed and given \
to you below. Your only job is to interpret that evidence in plain \
language.

RULES (follow every one exactly):

1. Use ONLY the evidence given to you. Never invent a metric, endpoint, \
status code, or threshold value that is not present in the input.
2. Distinguish OBSERVATION (a fact already in the evidence) from \
INTERPRETATION (your own reading of it). Do not blur the two.
3. Never claim an infrastructure root cause (e.g. "database locking", \
"network congestion", "a memory leak") unless such telemetry literally \
appears in the evidence -- it never does today. Localize WHERE and WHICH \
threshold, never WHY at an infrastructure level.
4. If the evidence is insufficient to explain something, say so \
explicitly (e.g. "infrastructure telemetry was not available to \
determine the root cause") -- never fill the gap with a guess.
5. `threshold_status` is authoritative and already decided -- you may \
explain it, never override, contradict, or recompute it.
6. Respond with ONLY a single JSON object, no prose, no markdown code \
fence, matching exactly:

{
  "summary": string (1-2 sentences, plain language),
  "severity": "none" | "low" | "medium" | "high",
  "findings": [ { "statement": string, "evidence_ref": string or null } ],
  "confidence": "low" | "medium" | "high",
  "limitations": [ string, ... ]
}
"""


class AIResultAnalyzer:
    """Real, OpenAI-compatible-provider-backed AIAnalyzer implementation.
    Reuses the SAME LLM_API_KEY/LLM_MODEL/LLM_BASE_URL/LLM_TIMEOUT_S
    config already established for intent interpretation
    (app/core/config.py) -- one provider configuration for this project,
    not a second, redundant one."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout_s: Optional[float] = None,
        http_client: Optional[httpx.Client] = None,
    ):
        self._api_key = LLM_API_KEY if api_key is None else api_key
        self._model = LLM_MODEL if model is None else model
        self._base_url = (LLM_BASE_URL if base_url is None else base_url).rstrip("/")
        self._timeout_s = LLM_TIMEOUT_S if timeout_s is None else timeout_s
        # Injected in tests via httpx.Client(transport=httpx.MockTransport(...))
        # for fully offline, deterministic testing of the REAL parsing/
        # validation code path -- same pattern as LLMIntentInterpreter.
        self._http_client = http_client

    def analyze(self, evidence: AIAnalysisInput) -> Optional[AIAnalysis]:
        try:
            raw_content = self._call_provider(evidence)
        except Exception:
            # Provider unreachable/timeout/auth failure/non-2xx -- analysis
            # is simply unavailable. Never raised further: the caller
            # (routes_runs.py) must remain fully usable without this.
            return None

        try:
            parsed = json.loads(_strip_code_fence(raw_content))
        except json.JSONDecodeError:
            return None

        try:
            return AIAnalysis.model_validate(parsed)
        except ValidationError:
            # Malformed/schema-invalid response -- safely rejected, never
            # corrupts the deterministic result.
            return None

    def _call_provider(self, evidence: AIAnalysisInput) -> str:
        client = self._http_client or httpx.Client(timeout=self._timeout_s)
        owns_client = self._http_client is None
        try:
            response = client.post(
                f"{self._base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json={
                    "model": self._model,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user", "content": evidence.model_dump_json()},
                    ],
                },
                timeout=self._timeout_s,
            )
            response.raise_for_status()
            body = response.json()
            return body["choices"][0]["message"]["content"]
        finally:
            if owns_client:
                client.close()


def _strip_code_fence(text: str) -> str:
    """Defensive only -- response_format=json_object should already prevent
    this, but not every OpenAI-compatible provider honors that field."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:]
        stripped = stripped.strip()
    return stripped
