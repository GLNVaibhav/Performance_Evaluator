export function TrafficBar({ label, percent, tone = "signal" }: { label: string; percent: number; tone?: "signal" | "success" }) {
  const barColor = tone === "signal" ? "bg-[var(--color-signal)]" : "bg-[var(--color-success)]";
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-44 shrink-0 truncate font-mono text-[13px] text-[var(--color-ink-dim)]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-raised)]">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-xs text-[var(--color-ink-dim)]">{percent}%</span>
    </div>
  );
}
