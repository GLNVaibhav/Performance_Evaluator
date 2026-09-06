import { useState } from "react";
import { ChevronRight } from "lucide-react";

export function JsonView({ data, label = "View raw data" }: { data: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] transition-colors"
      >
        <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
      </button>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto rounded border border-[var(--color-hairline)] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-dim)]">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
