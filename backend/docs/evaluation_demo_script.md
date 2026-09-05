# 5-Minute Evaluation Demonstration Script

Every command below was actually run and its real output captured during
the Dev-3 gate review of commit `0375e2c` (see the review report). No
output is invented.

## Setup (once)

```powershell
cd demo-api
python -m uvicorn app.main:app --host 127.0.0.1 --port 8080   # separate terminal

cd backend
$env:LLM_API_KEY = "<your OpenAI-compatible provider key>"
$env:LLM_BASE_URL = "https://openrouter.ai/api/v1"   # or https://api.openai.com/v1, etc.
$env:LLM_MODEL = "openai/gpt-4o-mini"
$env:K6_BINARY = "C:\Program Files\k6\k6.exe"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000   # separate terminal
```

## STEP 1 — Natural language input

```powershell
$body = @{ user_input = "Simulate 30 users on my ecommerce API for 20 seconds. Most should browse products, some should view product details, and a few should checkout. Keep p95 latency below 800ms." } | ConvertTo-Json
```

## STEP 2 — AI interpretation

```powershell
$interp = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/intents/interpret" -Method POST -ContentType "application/json" -Body $body
$interp.status        # real result observed: "COMPLETE"
$interp.intent | ConvertTo-Json -Depth 6
```
Real observed output includes `test_type: baseline`, `concurrent_users: 30`,
`duration: "20s"`, `endpoints: [/products, /products/{product_id}, /checkout]`
(all from the target's real, known surface), weighted per the "most/some/few"
phrasing, `p95_latency_ms: 800`.

## STEP 3 — Deterministic validation (compilation)

```powershell
$compileBody = $interp.intent | ConvertTo-Json -Depth 6
$compiled = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/intents/compile" -Method POST -ContentType "application/json" -Body $compileBody
$compiled.status       # real result observed: "READY"
$compiled.test_plan | ConvertTo-Json -Depth 6
```
**STOP here to show the boundary**: nothing has executed yet.
`Invoke-RestMethod "http://127.0.0.1:8000/api/v1/runs/anything"` at this
point returns 404 -- no run exists.

## STEP 4 — Human approval boundary (explicit, separate action)

```powershell
$runBody = @{ plan = $compiled.test_plan; target = @{ base_url = "http://127.0.0.1:8080" } } | ConvertTo-Json -Depth 6
$run = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/runs" -Method POST -ContentType "application/json" -Body $runBody
$run.run_id, $run.status   # real result observed: a run_id, "QUEUED"
```

## STEP 5 — Real k6 execution (poll to terminal state)

```powershell
do {
  Start-Sleep -Seconds 1
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/runs/$($run.run_id)"
  $status.status
} while ($status.status -in @("QUEUED", "RUNNING"))
# real observed: 12 polls of RUNNING, then COMPLETED
```

## STEP 6 — Endpoint-level intelligence (real results)

```powershell
$result = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/runs/$($run.run_id)/result"
$result.threshold_status                     # real observed: "PASS"
$result.metrics.total_requests                # real observed: 1677
$result.metrics.error_rate                     # real observed: 0.0
$result.metrics.per_endpoint | Format-Table endpoint, total_requests, p95_ms, error_rate
```
Real observed per-endpoint breakdown (one real k6 run):

| endpoint | requests | p95_ms | error_rate |
|---|---|---|---|
| /products | 991 | 2.17 | 0.0 |
| /products/{product_id} | 234 | 1.98 | 0.0 |
| /checkout | 226 | 2.12 | 0.0 |

## Bonus (if time allows): show the safety net working

Re-run steps 1-3 with `"Test my ecommerce API."` -- real observed:
interpretation status `INCOMPLETE`, every field `null` (nothing invented),
compile status `NEEDS_CLARIFICATION` with concrete `{field, question}`
pairs (`test_type`, `target_scope.endpoints`).
