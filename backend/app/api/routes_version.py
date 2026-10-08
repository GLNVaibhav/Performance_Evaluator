"""Reproducibility manifest route (Phase 11). Public, unauthenticated,
read-only: the manifest contains version identities and configuration
NAMES only — never secret values, never filesystem paths."""

from fastapi import APIRouter

from app.version_manifest import build_version_manifest

router = APIRouter()


@router.get("/version")
def version() -> dict:
    return build_version_manifest().model_dump()
