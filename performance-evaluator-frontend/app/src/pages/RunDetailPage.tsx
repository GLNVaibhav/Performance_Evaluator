import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { runsApi } from "../api/runs";
import type { TestResult } from "../api/types";
import { ResultsPanel } from "../components/results/ResultsPanel";
import { ApiError } from "../api/client";

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    runsApi
      .result(runId)
      .then(setResult)
      .catch((e) => setError(e instanceof ApiError ? String(e.detail) : "failed to load result"));
  }, [runId]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <Link to="/history" className="mb-6 flex items-center gap-1.5 text-[13px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
        <ArrowLeft size={14} />
        Back to run history
      </Link>
      {error && <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-dim)]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">{error}</div>}
      {result && <ResultsPanel result={result} />}
    </div>
  );
}
