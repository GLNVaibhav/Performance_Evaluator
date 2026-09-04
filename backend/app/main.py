from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes_health import router as health_router
from app.api.routes_runs import router as runs_router
from app.storage.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Autonomous Performance Evaluator - Backend", lifespan=lifespan)

app.include_router(health_router, prefix="/api/v1")
app.include_router(runs_router, prefix="/api/v1")
