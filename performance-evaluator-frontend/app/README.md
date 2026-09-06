# Performance Evaluator — Frontend

AI Performance Intelligence control plane for the Performance Evaluator
backend (`https://github.com/GLNVaibhav/Performance_Evaluator`).

Every screen is wired to real, verified backend endpoints -- nothing is
mocked. See `src/api/types.ts` for the exact schemas, each field checked
directly against the backend's actual Pydantic models before being typed
here.

## Real backend endpoints used

```
GET  /api/v1/health
GET  /api/v1/intents/known-endpoints
POST /api/v1/intents/interpret
POST /api/v1/intents/compile
POST /api/v1/runs
GET  /api/v1/runs
GET  /api/v1/runs/{run_id}
GET  /api/v1/runs/{run_id}/result
```

`POST /api/v1/intents/interpret-and-compile` also exists on the backend
(a convenience composition of the two calls above) but isn't used by this
frontend -- the mission flow deliberately makes two separate, real
sequential calls (interpret, then compile) so each pipeline stage in the
UI corresponds to its own real network round trip, not a staged reveal of
data that all arrived in one response.

## Run it

```bash
# 1. Start the canonical demo API (separate terminal)
cd demo-api
python -m uvicorn app.main:app --host 127.0.0.1 --port 8080

# 2. Start the backend (separate terminal) -- set a real LLM key to see
#    the AI interpretation stage actually succeed; without one, /interpret
#    will correctly return INTERPRETATION_FAILURE (the frontend handles
#    this gracefully -- it's a real backend state, not an error case).
cd backend
export LLM_API_KEY="<your OpenAI-compatible provider key>"
export LLM_BASE_URL="https://api.openai.com/v1"   # or any compatible provider
export K6_BINARY="/path/to/k6"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3. Start this frontend
npm install
npm run dev
# open http://127.0.0.1:5173
```

To point at a backend running somewhere other than
`http://127.0.0.1:8000`, copy `.env.example` to `.env.local` and set
`VITE_API_BASE_URL`.

## What's real vs. what to know

- **Every metric, status, and JSON blob shown is live backend data** --
  verified end-to-end with a real k6 run against the real demo API during
  development (compile -> run -> poll -> result, every field checked
  against the actual response).
- **No fabricated AI commentary.** The "Performance insight" line on the
  results page is a deterministic template over real `per_endpoint` data
  (highest error rate, or highest p95 vs. highest traffic) -- never
  generated text.
- **The human approval gate is real**, not decorative: nothing is POSTed
  to `/runs` until you click "Approve & execute".
- **INTERPRETATION_FAILURE is expected without a configured `LLM_API_KEY`**
  -- the interpreter provider (`interpreter_provider.py`) is wired to the
  real LLM-backed interpreter by default, not the deterministic fixture.
