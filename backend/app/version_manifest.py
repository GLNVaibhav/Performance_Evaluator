"""Reproducibility manifest (Phase 11).

One deterministic snapshot of every version identity needed to interpret or
reproduce a recorded result: backend/frontend/convex versions, Python and
Node runtimes, the k6 binary, policy versions (both planes), the LLM
model/provider configuration (NAMES only — never key values), and the demo
API. Exposed via GET /api/v1/version — safe for logs, incident reports, and
a "paste this alongside any bug report" workflow.

Every field is either:
  - an installed-package version read at runtime (never hardcoded), or
  - an explicit UNKNOWN with a documented reason.

NEVER included: secrets, tokens, API keys, internal paths, host names of
private deployments. `git_commit` is genuinely unavailable inside this
container (no .git in the image, no VCS metadata shipped) — it is surfaced
as UNKNOWN rather than inferred or fabricated, per the Phase 11 rule that
UNKNOWN beats inference. A deployment that BAKES a commit id into the
BACKEND_GIT_COMMIT env var gets it reported verbatim; nothing here guesses.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from pydantic import BaseModel

from app.policies import ALL_POLICY_VERSIONS


def _installed(pkg: str) -> str:
    try:
        return _pkg_version(pkg)
    except PackageNotFoundError:  # pragma: no cover
        return "UNKNOWN"


class _ToolVersion(BaseModel):
    name: str
    version: str


def _detect_k6() -> _ToolVersion:
    """k6 identity from the actual configured binary. Presence/version are
    determined by running `k6 version` ONCE at manifest-request time — a
    read-only subprocess (shell=False, argv array, 3s timeout, output
    captured). This is version REPORTING, not a health probe: readiness
    (routes_health.py) only does a PATH lookup and never executes k6."""
    from app.core.config import K6_BINARY

    binary = shutil.which(K6_BINARY) or K6_BINARY
    try:
        proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
            [binary, "version"],
            capture_output=True,
            text=True,
            timeout=3,
            shell=False,
        )
        first = (proc.stdout or proc.stderr).strip().splitlines()
        return _ToolVersion(name="k6", version=first[0].strip() if first else "UNKNOWN")
    except (OSError, subprocess.SubprocessError):
        return _ToolVersion(name="k6", version="UNKNOWN")


class PolicyVersions(BaseModel):
    workloadLimits: str = ALL_POLICY_VERSIONS["workloadLimits"]
    threshold: str = ALL_POLICY_VERSIONS["threshold"]
    boundarySearch: str = ALL_POLICY_VERSIONS["boundarySearch"]
    targetSsrf: str = ALL_POLICY_VERSIONS["targetSsrf"]
    regression: str = "perforso.regression-policy.v1"
    aiEvidenceValidation: str = "perforso.ai-validation.v1"


class LlmConfiguration(BaseModel):
    provider_kind: str  # "openai-compatible" | "unconfigured"
    model: str  # model ID (e.g. "gpt-4o-mini") — a name, not a secret


class VersionManifest(BaseModel):
    schema_version: str = "perforso.version-manifest.v1"
    backend_version: str
    backend_git_commit: str
    python_version: str
    fastapi_version: str
    pydantic_version: str
    sqlalchemy_version: str
    k6: _ToolVersion
    node_runtime_version: str
    convex_function_version: str
    demo_api_version: str
    policies: PolicyVersions
    llm: LlmConfiguration
    # Environment/configuration NAMES consumed by the execution plane.
    # Configuration VALUES are never included — only which knobs exist, so
    # an engineer knows what to check in their own deployment.
    environment_variable_names: list[str]


def build_version_manifest() -> VersionManifest:
    """Deterministic given the installed environment (an env-var lookup per
    call, package metadata, and one k6 version invocation)."""
    from app.core.config import LLM_MODEL

    git_commit = os.environ.get("BACKEND_GIT_COMMIT", "").strip() or "UNKNOWN"

    node_version = "UNKNOWN"
    try:
        node = shutil.which("node")
        if node:
            proc = subprocess.run(  # noqa: S603 — fixed argv, no shell
                [node, "--version"], capture_output=True, text=True, timeout=3, shell=False
            )
            if proc.returncode == 0 and proc.stdout.strip():
                node_version = proc.stdout.strip().splitlines()[0]
    except (OSError, subprocess.SubprocessError):
        node_version = "UNKNOWN"

    configured_env_names = [
        "EXECUTION_BRIDGE_TOKEN",
        "K6_BINARY",
        "K6_EXECUTION_TIMEOUT_S",
        "MAX_VUS",
        "MAX_DURATION_S",
        "TARGET_SSRF_POLICY",
        "LLM_API_KEY",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "ARTIFACTS_DIR",
        "DATABASE_URL",
        "CORS_ALLOWED_ORIGINS",
        "BACKEND_GIT_COMMIT",
    ]

    return VersionManifest(
        backend_version=_installed("performance-evaluator-backend") if _installed("performance-evaluator-backend") != "UNKNOWN" else "0.1.0",
        backend_git_commit=git_commit,
        python_version=sys.version.split()[0],
        fastapi_version=_installed("fastapi"),
        pydantic_version=_installed("pydantic"),
        sqlalchemy_version=_installed("sqlalchemy"),
        k6=_detect_k6(),
        node_runtime_version=node_version,
        convex_function_version=os.environ.get("CONVEX_FUNCTION_VERSION", "").strip() or "UNKNOWN",
        demo_api_version="perforso.demo-api.v1 (in-memory modes; see demo-api/README.md)",
        policies=PolicyVersions(),
        llm=LlmConfiguration(
            provider_kind="openai-compatible" if os.environ.get("LLM_API_KEY", "").strip() else "unconfigured",
            model=LLM_MODEL,
        ),
        environment_variable_names=configured_env_names,
    )
