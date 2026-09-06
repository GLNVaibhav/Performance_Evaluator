import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { runsApi } from "../api/runs";
import type { RunStatusResponse } from "../api/types";
import { StatusDot } from "../components/common/StatusDot";

const TONE: Record<string, "success" | "signal" | "danger" | "muted"> = {
  COMPLETED: "success",
  RUNNING: "signal",
  QUEUED: "signal",
  EXECUTION_ERROR: "danger",
  CANCELLED: "muted",
};

export function RunHistoryPage() {
  const [runs, setRuns] = useState<RunStatusResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    runsApi
      .list(50)
      .then(setRuns)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="text-[22px] font-semibold tracking-tight">Run history</h1>
      <p className="mt-1 text-[14px] text-[var(--color-ink-dim)]">Every evaluation this backend has executed, most recent first.</p>

      <div className="mt-8 overflow-hidden rounded-lg border border-[var(--color-hairline)]">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[var(--color-panel)]">
            <tr className="text-[11px] text-[var(--color-muted)]">
              <th className="px-4 py-3 font-normal">Status</th>
              <th className="px-4 py-3 font-normal">Run ID</th>
              <th className="px-4 py-3 font-normal">Created</th>
              <th className="px-4 py-3 font-normal">Finished</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.run_id}
                onClick={() => navigate(`/history/${r.run_id}`)}
                className="cursor-pointer border-t border-[var(--color-hairline)] bg-[var(--color-panel)]/40 hover:bg-[var(--color-panel-raised)]"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={TONE[r.status] ?? "muted"} />
                    {r.status}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-[var(--color-ink-dim)]">{r.run_id.slice(0, 16)}…</td>
                <td className="px-4 py-3 text-[var(--color-ink-dim)]">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-[var(--color-ink-dim)]">
                  {r.finished_at ? new Date(r.finished_at).toLocaleTimeString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && runs.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-[var(--color-muted)]">
            No runs yet — launch a mission from Mission Control.
          </div>
        )}
      </div>
    </div>
  );
}
