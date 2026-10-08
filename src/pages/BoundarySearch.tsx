import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "@convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AiAnalysisPanel } from "@/components/AiAnalysisPanel";

/**
 * Deterministic adaptive boundary search UI.
 *
 * Displays ONLY factual state: the iteration sequence (each one a real k6
 * run), the current boundary observations, and — when finished — the
 * estimated safe operating region in the mandated terminology. No capacity
 * score, no "winner", no certainty beyond the observed experiments.
 */

type Experiment = {
  runId: string;
  iteration: number;
  targetVus: number;
  status: string;
  thresholdStatus: string | null;
  externalRunId: string | null;
  metrics?: { p95: number; totalRequests: number; errorRate: number } | null;
};

type SearchDoc = {
  _id: string;
  status: string;
  targetBaseUrl: string;
  minVus: number;
  maxVus: number;
  tolerance: number;
  maximumExperiments: number;
  lowestKnownPassVus?: number;
  highestKnownFailVus?: number;
  currentVus?: number;
  experimentCount: number;
  basePlan: { rampDuration: string; holdDuration: string; selectedEndpoints: string[]; thresholds: { p95LatencyMs: number; errorRate: number } };
  result?: {
    status: string;
    lowerBound?: number;
    upperBound?: number;
    lowestObservedFailingVus?: number;
    highestObservedPassingVus?: number;
    note: string;
    stopReason?: string;
  };
  createdAt: number;
  finishedAt?: number;
};

export default function BoundarySearch() {
  const searches = (useQuery(api.boundarySearch.listSearches) ?? []) as unknown as SearchDoc[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useQuery(
    api.boundarySearch.getSearch,
    selectedId ? ({ searchId: selectedId } as never) : ("skip" as never),
  ) as
    | { search: SearchDoc; experiments: Experiment[] }
    | null
    | undefined;

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Adaptive boundary search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deterministic search for an <span className="text-foreground">estimated safe operating region</span> — one
          real k6 experiment per iteration, midpoint bisecting between the highest observed PASS and the lowest
          observed FAIL. No AI, no capacity score, no exact-capacity claims.
        </p>
      </div>

      <CreateSearch onCreated={setSelectedId} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Searches</CardTitle>
          <CardDescription>{searches.length} recorded</CardDescription>
        </CardHeader>
        <CardContent>
          {searches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No searches yet — create one above.</p>
          ) : (
            <div className="divide-y divide-border/50">
              {searches.map((s) => (
                <button
                  key={s._id}
                  onClick={() => setSelectedId(s._id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 py-2.5 px-2 -mx-2 rounded-md text-left transition-colors",
                    selectedId === s._id ? "bg-primary/10" : "hover:bg-secondary/40",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-primary">#{s._id.slice(-6)}</span>
                      <Badge variant={s.status === "completed" ? "success" : s.status === "active" ? "warning" : "destructive"}>
                        {s.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {s.minVus}–{s.maxVus} VUs · {s.experimentCount}/{s.maximumExperiments} experiments ·{" "}
                        {s.basePlan.selectedEndpoints.join(", ")}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground/70 font-mono mt-0.5">
                      p95 ≤ {s.basePlan.thresholds.p95LatencyMs}ms · {s.targetBaseUrl}
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-mono text-xs text-muted-foreground">
                    {s.lowestKnownPassVus != null && <div>pass ≥ {s.lowestKnownPassVus} VUs</div>}
                    {s.highestKnownFailVus != null && <div>fail ≤ {s.highestKnownFailVus} VUs</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {detail && (
        <>
          <SearchDetail search={detail.search} experiments={detail.experiments} />
          <AiAnalysisPanel
            subjectKind="search"
            subjectId={detail.search._id}
            queryFn={api.aiQueries.latestForSearch}
          />
        </>
      )}
    </div>
  );
}

function CreateSearch({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useMutation(api.boundarySearch.createSearch);
  const [form, setForm] = useState({
    targetBaseUrl: "http://127.0.0.1:8080",
    minVus: 1,
    maxVus: 64,
    rampDuration: "3s",
    holdDuration: "5s",
    endpoint: "/products",
    p95LatencyMs: 3,
    errorRate: 0.01,
    maximumExperiments: 8,
    tolerance: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const id = await create({
        targetBaseUrl: form.targetBaseUrl,
        minVus: form.minVus,
        maxVus: form.maxVus,
        rampDuration: form.rampDuration,
        holdDuration: form.holdDuration,
        selectedEndpoints: [form.endpoint],
        thresholds: { p95LatencyMs: form.p95LatencyMs, errorRate: form.errorRate },
        maximumExperiments: form.maximumExperiments,
        tolerance: form.tolerance,
      });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New search</CardTitle>
        <CardDescription>
          Every iteration must fit the existing safety limits (≤ 2000 VUs, ramp+hold ≤ 90s). The controller operates
          strictly inside the range you set.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="bs-target" className="text-xs">target URL</Label>
          <Input id="bs-target" className="font-mono text-xs" value={form.targetBaseUrl} onChange={set("targetBaseUrl")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-endpoint" className="text-xs">endpoint</Label>
          <Input id="bs-endpoint" className="font-mono text-xs" value={form.endpoint} onChange={set("endpoint")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-min" className="text-xs">min VUs</Label>
          <Input id="bs-min" type="number" min={1} value={form.minVus} onChange={set("minVus")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-max" className="text-xs">max VUs (ceiling)</Label>
          <Input id="bs-max" type="number" min={1} value={form.maxVus} onChange={set("maxVus")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-ramp" className="text-xs">ramp duration</Label>
          <Input id="bs-ramp" className="font-mono text-xs" value={form.rampDuration} onChange={set("rampDuration")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-hold" className="text-xs">hold duration</Label>
          <Input id="bs-hold" className="font-mono text-xs" value={form.holdDuration} onChange={set("holdDuration")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-p95" className="text-xs">p95 threshold (ms)</Label>
          <Input id="bs-p95" type="number" min={1} value={form.p95LatencyMs} onChange={set("p95LatencyMs")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-err" className="text-xs">error-rate threshold</Label>
          <Input id="bs-err" type="number" step="0.01" min={0} max={1} value={form.errorRate} onChange={set("errorRate")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-maxexp" className="text-xs">max experiments</Label>
          <Input id="bs-maxexp" type="number" min={1} max={20} value={form.maximumExperiments} onChange={set("maximumExperiments")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bs-tol" className="text-xs">VU tolerance</Label>
          <Input id="bs-tol" type="number" min={0} value={form.tolerance} onChange={set("tolerance")} />
        </div>
        <div className="col-span-2 flex items-end justify-end gap-3 sm:col-span-4">
          {error && <span className="text-xs text-red-400 font-mono">{error}</span>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "starting…" : "Start deterministic search"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SearchDetail({ search, experiments }: { search: SearchDoc; experiments: Experiment[] }) {
  const sorted = useMemo(() => [...experiments].sort((a, b) => a.iteration - b.iteration), [experiments]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Search #{search._id.slice(-6)} <Badge variant={search.status === "completed" ? "success" : search.status === "active" ? "warning" : "destructive"}>{search.status}</Badge>
        </CardTitle>
        <CardDescription>
          Range {search.minVus}–{search.maxVus} VUs · tolerance {search.tolerance} · max {search.maximumExperiments}{" "}
          experiments · ramp {search.basePlan.rampDuration} + hold {search.basePlan.holdDuration} per iteration
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Iterations (each a separate real k6 execution)
          </div>
          <div className="divide-y divide-border/40 rounded-md border border-border/50">
            {sorted.length === 0 && <div className="p-3 text-sm text-muted-foreground">No experiments yet.</div>}
            {sorted.map((e) => (
              <div key={e.runId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground">#{e.iteration}</span>
                  <span className="font-mono text-sm">{e.targetVus} VUs</span>
                  {e.thresholdStatus && (
                    <Badge variant={e.thresholdStatus === "PASS" ? "success" : "destructive"}>{e.thresholdStatus}</Badge>
                  )}
                  {!e.thresholdStatus && e.status !== "completed" && (
                    <Badge variant="secondary">{e.status}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 font-mono text-xs text-muted-foreground">
                  {e.metrics && (
                    <span>
                      p95 {e.metrics.p95?.toFixed(2)}ms · {e.metrics.totalRequests} req
                    </span>
                  )}
                  <Link to={`/app/runs/${e.runId}`} className="text-primary hover:underline">
                    run #{e.runId.slice(-6)}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-emerald-400/90">Highest observed passing load</div>
            <div className="mt-1 font-mono text-lg">{search.lowestKnownPassVus != null ? `${search.lowestKnownPassVus} VUs` : "unknown (no PASS observed yet)"}</div>
          </div>
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-red-400/90">Lowest observed failing load</div>
            <div className="mt-1 font-mono text-lg">{search.highestKnownFailVus != null ? `${search.highestKnownFailVus} VUs` : "unknown (no FAIL observed yet)"}</div>
          </div>
        </div>

        {search.result && (
          <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-4">
            <div className="text-sky-400 text-sm font-medium mb-1">Estimated safe operating region</div>
            <div className="font-mono text-2xl">
              {search.result.lowerBound != null ? `${search.result.lowerBound}` : "?"}
              {" – "}
              {search.result.upperBound != null ? `${search.result.upperBound}` : "?"}
              {" VUs"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {search.result.upperBound == null && search.result.lowerBound != null
                ? "No failing point was observed inside the tested range; the upper bound is unknown, not zero."
                : search.result.lowerBound == null && search.result.upperBound != null
                  ? "No passing point was observed; the lower bound is unknown."
                  : null}
              {search.result.stopReason ? ` · stopped: ${search.result.stopReason.replace(/_/g, " ")}` : ""}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground/80">{search.result.note}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
