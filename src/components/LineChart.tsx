import { useMemo } from "react";

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export function LineChart({
  series,
  height = 180,
  yLabel,
}: {
  series: Series[];
  height?: number;
  yLabel?: string;
}) {
  const width = 600;
  const pad = { top: 10, right: 12, bottom: 20, left: 40 };

  const { paths, maxY, maxX } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    const maxX = Math.max(1, ...series.map((s) => s.values.length - 1));
    const maxY = Math.max(1, ...all);
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const paths = series.map((s) => {
      const pts = s.values.map((v, i) => {
        const x = pad.left + (i / maxX) * innerW;
        const y = pad.top + innerH - (v / maxY) * innerH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return { ...s, d: pts.length ? `M${pts.join(" L")}` : "" };
    });
    return { paths, maxY, maxX };
  }, [series, height, pad.bottom, pad.left, pad.right, pad.top]);

  const yTicks = [0, 0.5, 1].map((f) => Math.round(maxY * f));

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={series.map((s) => s.label).join(", ")}>
        {yTicks.map((t, i) => {
          const y = pad.top + (height - pad.top - pad.bottom) * (1 - (maxY ? t / maxY : 0));
          return (
            <g key={i}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="hsl(224 18% 18%)" strokeWidth={1} />
              <text x={pad.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="hsl(222 12% 58%)" fontFamily="JetBrains Mono, monospace">
                {t}
              </text>
            </g>
          );
        })}
        {paths.map((p) => (
          <g key={p.label}>
            <path d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize={9} fill="hsl(222 12% 45%)" fontFamily="JetBrains Mono, monospace">
          t={maxX}s
        </text>
        {yLabel && (
          <text x={pad.left} y={height - 6} fontSize={9} fill="hsl(222 12% 45%)" fontFamily="JetBrains Mono, monospace">
            {yLabel}
          </text>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span className="h-1.5 w-4 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
