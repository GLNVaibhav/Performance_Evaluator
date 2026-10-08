# Controlled demo API image — the experimental subject for the evaluation
# suite (docs/EVALUATION.md). Deterministic in-memory modes: normal /
# db_latency / checkout_bottleneck / error_injection. Never load-test
# production systems; this container exists so every evaluation is
# reproducible against a subject we control.
#
# Build:  docker build -f demo-api/Dockerfile -t perforso/demo-api:latest ./demo-api
# Run:    see docker-compose.yml / demo-api/README.md

FROM python:3.10-slim

WORKDIR /demo-api

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY run.py .

EXPOSE 8080

# HOST/PORT and the mode-tuning variables (DB_LATENCY_MS, CHECKOUT_DELAY_MS,
# ERROR_INJECTION_FAIL_PERCENT, DEMO_USERNAME, DEMO_PASSWORD, DEMO_TOKEN)
# are read from the environment at runtime — see demo-api/README.md.
CMD ["python", "run.py"]
