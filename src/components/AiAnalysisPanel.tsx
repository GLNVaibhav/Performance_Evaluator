import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * AI Performance Intelligence panel (Phase 9).
 *
 * Renders the stored, validated AI analysis — always visibly labeled as
 * INTERPRETATION. The authoritative measured metrics live elsewhere on the
 * page and are never modified by this section. Every statement carries its
 * OBSERVED/INFERRED/UNKNOWN classification and evidence references;
 * rejected model claims are displayed with their rejection reasons.
 */

export type AiAnalysisDoc = {
  _id: string;
  version: number;
  analyzerKind: string; // "llm" | "deterministic"
  model?: string;
  promptVersion: string;
  generatedAt: number;
  analysis: {
    summary: string;
    observations: { statement: string; classification: string; evidence: string[] }[];
    thresholdAssessment: { status: string; evidence: string[] };
    endpointObservations: { endpoint: string; statement: string; classification: string; evidence: string[] }[];
    boundaryAssessment: {
      highestObservedPass?: number | null;
      lowestObservedFail?: number | null;
      estimatedSafeOperatingRegion?: { lowerBound?: number | null; upperBound?: number | null } | null;
    };
    limitations: string[];
    confidenceNotes: string[];
    rejected: { reason: string; excerpt: string }[];
  };
  evidenceRefs: string[];
};

const CLASS_STYLE: Record<string, string> = {
  OBSERVED: "border-emerald-500/40 text-emerald-400",
  INFERRED: "border-amber-500/40 text-amber-400",
  UNKNOWN: "border-slate-500/40 text-slate-300",
};

function ClassificationBadge({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide",
        CLASS_STYLE[value] ?? "border-border text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

export function AiAnalysisPanel({
  subjectKind,
  subjectId,
  queryFn,
}: {
  subjectKind: "run" | "search";
  subjectId: string;
  queryFn: (typeof api.aiQueries)["latestForRun" | "latestForSearch"];
}) {
  const analysis = useQuery(queryFn, { [subjectKind === "run" ? "runId" : "searchId"]: subjectId } as never) as
    | AiAnalysisDoc
    | null
    | undefined;
  const generate = useAction(subjectKind === "run" ? api.aiEntries.analyzeMyRun : api.aiEntries.analyzeMySearch);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await generate(subjectKind === "run" ? ({ runId: subjectId } as never) : ({ searchId: subjectId } as never));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-violet-500/30">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          AI Performance Intelligence
          <Badge variant="secondary" className="font-mono text-[10px] border-violet-500/40 text-violet-300">
            interpretation only
          </Badge>
          {analysis && (
            <>
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{analysis.version}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {analysis.analyzerKind === "llm"
                  ? `AI analyst · ${analysis.model ?? "model"}`
                  : "deterministic fallback"}
              </Badge>
            </>
          )}
        </CardTitle>
        <CardDescription>
          AI interpretation of the recorded evidence — advisory only. The measured metrics and threshold verdicts on
          this page are authoritative and are never modified by the AI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!analysis && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card p-3">
            <p className="text-xs text-muted-foreground">
              No analysis generated yet. The analyst reads only the stored, backend-authoritative evidence of this{" "}
              {subjectKind === "run" ? "run" : "search"} and returns a validated, classification-tagged
              interpretation.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
              {busy ? "analyzing…" : "Generate analysis"}
            </Button>
          </div>
        )}

        {analysis && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-[10px] text-muted-foreground">
                prompt {analysis.promptVersion} · generated {new Date(analysis.generatedAt).toLocaleString()}
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
                {busy ? "analyzing…" : "Regenerate (new version)"}
              </Button>
            </div>

            <p className="text-sm leading-relaxed">{analysis.analysis.summary}</p>

            {analysis.analysis.observations.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Observations</div>
                {analysis.analysis.observations.map((o, i) => (
                  <div key={i} className="rounded-md border border-border/60 bg-background/60 p-2.5">
                    <div className="flex items-start gap-2">
                      <ClassificationBadge value={o.classification} />
                      <p className="text-sm leading-relaxed text-muted-foreground">{o.statement}</p>
                    </div>
                    {o.evidence.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground/60">
                        {o.evidence.map((e, j) => (
                          <span key={j} className="rounded bg-muted/40 px-1 py-0.5">
                            {e}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {analysis.analysis.thresholdAssessment.status !== "NOT_ASSESSED" &&
              analysis.analysis.thresholdAssessment.status !== "" && (
                <div className="rounded-md border border-border/60 bg-background/60 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Threshold assessment</div>
                  <p className="mt-1 text-sm">
                    Restated verdict: <span className="font-mono">{analysis.analysis.thresholdAssessment.status}</span>{" "}
                    <span className="text-[11px] text-muted-foreground">(backend-authoritative, unchanged)</span>
                  </p>
                </div>
              )}

            {analysis.analysis.endpointObservations.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Endpoint observations</div>
                {analysis.analysis.endpointObservations.map((o, i) => (
                  <div key={i} className="rounded-md border border-border/60 bg-background/60 p-2.5">
                    <div className="flex items-start gap-2">
                      <ClassificationBadge value={o.classification} />
                      <div>
                        <span className="font-mono text-xs text-foreground/80">{o.endpoint}</span>
                        <p className="text-sm leading-relaxed text-muted-foreground">{o.statement}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {analysis.analysis.boundaryAssessment &&
              (analysis.analysis.boundaryAssessment.highestObservedPass != null ||
                analysis.analysis.boundaryAssessment.lowestObservedFail != null) && (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-sky-400">Boundary analysis</div>
                  <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                    <div>
                      highest observed PASS: {analysis.analysis.boundaryAssessment.highestObservedPass ?? "unknown"} VUs
                    </div>
                    <div>
                      lowest observed FAIL:{" "}
                      {analysis.analysis.boundaryAssessment.lowestObservedFail ?? "not observed"} VUs
                    </div>
                    {analysis.analysis.boundaryAssessment.estimatedSafeOperatingRegion && (
                      <div>
                        estimated safe operating region:{" "}
                        {analysis.analysis.boundaryAssessment.estimatedSafeOperatingRegion.lowerBound ?? "?"}–
                        {analysis.analysis.boundaryAssessment.estimatedSafeOperatingRegion.upperBound ?? "?"} VUs
                        (within tested range)
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                    Restated from the deterministic search state — not a capacity claim.
                  </p>
                </div>
              )}

            {analysis.analysis.limitations.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Limitations</div>
                <ul className="mt-1 space-y-1">
                  {analysis.analysis.limitations.map((l, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-2">
                      <span className="text-violet-400/70 font-mono">▸</span> {l}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.analysis.rejected.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <div className="text-[10px] uppercase tracking-wider text-red-400">
                  Rejected model claims (deterministic validation)
                </div>
                <ul className="mt-1 space-y-1">
                  {analysis.analysis.rejected.map((r, i) => (
                    <li key={i} className="text-xs text-muted-foreground font-mono">
                      ✗ [{r.reason}] “{r.excerpt}”
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
