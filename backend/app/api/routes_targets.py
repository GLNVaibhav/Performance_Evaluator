"""Target discovery: given a user-supplied OpenAPI URL / base URL /
authentication (app/schemas/test_plan.py::TargetConfig), fetch and
validate the target's real OpenAPI surface, and return ONLY sanitized,
LLM-safe metadata -- never the raw TargetConfig, never a secret.

Deliberately separate from POST /api/v1/runs, mirroring the existing
POST /api/v1/intents/compile boundary (app/api/routes_intents.py): this
endpoint performs no execution, no persistence, and no DB write -- it
only fetches a target's OpenAPI document (reusing the existing,
unmodified app/services/k6_engine/openapi_loader.py) and reports what it
found. It never touches RunService, PerformanceEngine, or the k6 engine.

This is the concrete "OpenAPI discovery" step in the intended user flow
(OpenAPI URL -> target/auth -> natural-language intent): a future
LLM-facing step consumes THIS response's `auth` field (SanitizedAuthMetadata)
and `endpoints` list, never a raw TargetConfig -- LLM integration itself
is out of scope for this work (see docs/target_auth_contract.md).
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.schemas.auth import SanitizedAuthMetadata, sanitize_auth
from app.schemas.test_plan import TargetConfig
from app.services.auth_headers import build_auth_headers
from app.services.k6_engine.openapi_loader import OpenAPILoadError, load_normalized
from app.services.target_url_safety import TargetURLSafetyError, validate_target_url_safety

router = APIRouter(prefix="/targets", tags=["targets"])


class TargetDiscoveryResponse(BaseModel):
    reachable: bool
    endpoints: List[str] = []
    auth: SanitizedAuthMetadata
    error: Optional[str] = None


@router.post("/discover", response_model=TargetDiscoveryResponse)
def discover_target(target: TargetConfig) -> TargetDiscoveryResponse:
    sanitized_auth = sanitize_auth(target.auth)

    try:
        validate_target_url_safety(target.base_url)
        if target.openapi_url:
            validate_target_url_safety(target.openapi_url)
    except TargetURLSafetyError as exc:
        return TargetDiscoveryResponse(reachable=False, auth=sanitized_auth, error=str(exc))

    try:
        spec = load_normalized(
            target.base_url,
            openapi_url=target.openapi_url,
            headers=build_auth_headers(target.auth),
        )
    except OpenAPILoadError as exc:
        return TargetDiscoveryResponse(reachable=False, auth=sanitized_auth, error=str(exc))

    endpoints = sorted({e.path for e in spec.endpoints})
    return TargetDiscoveryResponse(reachable=True, endpoints=endpoints, auth=sanitized_auth, error=None)
