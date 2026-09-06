from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes_health import router as health_router
from app.api.routes_intents import router as intents_router
from app.api.routes_runs import router as runs_router
from app.api.routes_targets import router as targets_router
from app.core.config import CORS_ALLOWED_ORIGINS
from app.storage.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Autonomous Performance Evaluator - Backend", lifespan=lifespan)

# Required for the browser-based frontend (a different origin -- Vite's
# dev server) to call this API at all; see app/core/config.py::
# CORS_ALLOWED_ORIGINS's docstring for the confirmed root cause this
# fixes. Explicit origins, no credentialed requests (this API never
# relies on browser-managed cookies -- auth, where used, is a plain JSON
# body field, e.g. TargetConfig.auth), and only the methods/headers this
# API's routes and the frontend's fetch wrapper actually use.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

app.include_router(health_router, prefix="/api/v1")
app.include_router(runs_router, prefix="/api/v1")
app.include_router(intents_router, prefix="/api/v1")
app.include_router(targets_router, prefix="/api/v1")
