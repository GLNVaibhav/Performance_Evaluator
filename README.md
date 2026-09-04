# Autonomous Performance Evaluator

"Describe the performance goal. The system plans, runs, investigates, and explains the test."

An autonomous performance evaluation platform that turns natural-language performance
objectives and application/API context into executable performance experiments, analyzes
real test results, and progressively identifies performance boundaries through
goal-directed adaptive experimentation.

## Status

Phase 1 (backend execution foundation) in progress. See `backend/` for the FastAPI
service, run lifecycle, domain contracts, and persistence layer.

## Branch model

- `main` — stable / demo-ready only
- `dev` — integration branch
- `feature/*` — individual development branches, PR'd into `dev`

## Team ownership

| Area | Owner |
|---|---|
| Backend, orchestration, domain contracts | Developer 1 |
| Performance engine (k6 renderer, payload generation, metrics) | Developer 2 |
| Integration / review gate | Developer 3 |
| Canonical demo target API | Developer 4 |
| Testing / tooling | Developer 5 |

## Layout

```
backend/       FastAPI app, domain schemas, run lifecycle, persistence
demo-api/      Canonical e-commerce demo target for performance testing
```
