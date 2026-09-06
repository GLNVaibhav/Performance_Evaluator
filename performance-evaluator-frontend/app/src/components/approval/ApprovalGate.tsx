import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AuthConfig, AuthType, TestPlan } from "../../api/types";

export function ApprovalGate({
  plan,
  targetBaseUrl,
  onApprove,
  busy,
}: {
  plan: TestPlan;
  targetBaseUrl: string;
  onApprove: (baseUrl: string, auth?: AuthConfig) => void;
  busy: boolean;
}) {
  const [url, setUrl] = useState(targetBaseUrl);
  // Sessions 1/2/2.5: the target may require bearer or API-key-header
  // auth for real k6 traffic (see backend/docs/target_auth_contract.md).
  // "none" (the default) reproduces the exact pre-existing no-auth
  // behavior -- omitting `auth` entirely on submit.
  const [authType, setAuthType] = useState<AuthType>("none");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [apiKey, setApiKey] = useState("");
  const weights = plan.endpoint_weights;
  const total = weights ? Object.values(weights).reduce((a, b) => a + b, 0) : 0;

  const authIncomplete =
    (authType === "bearer" && !token.trim()) ||
    (authType === "api_key_header" && (!headerName.trim() || !apiKey.trim()));

  function handleApprove() {
    let auth: AuthConfig | undefined;
    if (authType === "bearer") {
      auth = { type: "bearer", token };
    } else if (authType === "api_key_header") {
      auth = { type: "api_key_header", header_name: headerName, api_key: apiKey };
    }
    onApprove(url, auth);
  }

  return (
    <div className="rounded-lg border border-[var(--color-signal)]/30 bg-gradient-to-b from-[var(--color-signal-dim)]/20 to-[var(--color-panel)] p-6">
      <div className="flex items-center gap-2.5">
        <ShieldCheck size={20} className="text-[var(--color-signal)]" />
        <div>
          <div className="text-[15px] font-semibold">Human approval required</div>
          <div className="text-[13px] text-[var(--color-ink-dim)]">
            The AI-generated workload has been validated. Review the execution plan before it runs.
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-4">
        <div>
          <div className="text-[11px] text-[var(--color-muted)]">Test type</div>
          <div className="mt-0.5 text-[14px] capitalize">{plan.test_type}</div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--color-muted)]">Target load</div>
          <div className="mt-0.5 text-[14px]">{plan.target_vus} virtual users</div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--color-muted)]">Duration</div>
          <div className="mt-0.5 text-[14px]">{plan.duration ?? `${plan.ramp_duration} → ${plan.hold_duration}`}</div>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[11px] text-[var(--color-muted)]">Endpoint mix</div>
        <div className="space-y-1.5">
          {plan.selected_endpoints.map((ep) => {
            const pct = weights ? Math.round(((weights[ep] ?? 0) / total) * 100) : Math.round(100 / plan.selected_endpoints.length);
            return (
              <div key={ep} className="flex items-center justify-between font-mono text-[13px]">
                <span className="text-[var(--color-ink-dim)]">{ep}</span>
                <span className="text-[var(--color-ink)]">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] text-[var(--color-muted)]">P95 latency</div>
          <div className="mt-0.5 text-[14px]">&lt; {plan.thresholds.p95_latency_ms}ms</div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--color-muted)]">Error rate</div>
          <div className="mt-0.5 text-[14px]">&lt; {(plan.thresholds.error_rate * 100).toFixed(1)}%</div>
        </div>
      </div>

      <div className="mt-5">
        <label className="text-[11px] text-[var(--color-muted)]">Target API base URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-hairline)] bg-black/30 px-3 py-2 font-mono text-[13px] text-[var(--color-ink)] focus:border-[var(--color-signal)]/50 focus:outline-none"
        />
      </div>

      <div className="mt-5">
        <label className="text-[11px] text-[var(--color-muted)]">Authentication (optional)</label>
        <select
          value={authType}
          onChange={(e) => setAuthType(e.target.value as AuthType)}
          className="mt-1 w-full rounded-md border border-[var(--color-hairline)] bg-black/30 px-3 py-2 text-[13px] text-[var(--color-ink)] focus:border-[var(--color-signal)]/50 focus:outline-none"
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="api_key_header">API key header</option>
        </select>

        {authType === "bearer" && (
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            type="password"
            className="mt-2 w-full rounded-md border border-[var(--color-hairline)] bg-black/30 px-3 py-2 font-mono text-[13px] text-[var(--color-ink)] focus:border-[var(--color-signal)]/50 focus:outline-none"
          />
        )}

        {authType === "api_key_header" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={headerName}
              onChange={(e) => setHeaderName(e.target.value)}
              placeholder="Header name (e.g. X-API-Key)"
              className="rounded-md border border-[var(--color-hairline)] bg-black/30 px-3 py-2 font-mono text-[13px] text-[var(--color-ink)] focus:border-[var(--color-signal)]/50 focus:outline-none"
            />
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key value"
              type="password"
              className="rounded-md border border-[var(--color-hairline)] bg-black/30 px-3 py-2 font-mono text-[13px] text-[var(--color-ink)] focus:border-[var(--color-signal)]/50 focus:outline-none"
            />
          </div>
        )}
        {authType !== "none" && (
          <div className="mt-1.5 text-[11px] text-[var(--color-muted)]">
            Sent only to the backend for this run's real target traffic -- never shown again, never logged.
          </div>
        )}
      </div>

      <div className="mt-6 flex gap-3">
        <button
          onClick={handleApprove}
          disabled={busy || !url.trim() || authIncomplete}
          className="flex-1 rounded-lg bg-[var(--color-signal)] py-3 text-[14px] font-semibold text-[#001018] transition-all hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Launching…" : "Approve & execute"}
        </button>
      </div>
    </div>
  );
}
