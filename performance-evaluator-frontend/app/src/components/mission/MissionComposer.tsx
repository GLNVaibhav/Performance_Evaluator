import { useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";

const DEMO_SCENARIO =
  "Simulate 25 users browsing my ecommerce API for 15 seconds. Most users should browse products, some should view product details, and a few should checkout. I need p95 latency below 1000ms.";

const CHIPS = [
  { label: "Browse-heavy ecommerce workload", value: DEMO_SCENARIO },
  {
    label: "Checkout stress scenario",
    value:
      "Stress test the checkout endpoint to find the breaking point. Ramp up users until p95 latency exceeds 1500ms.",
  },
  {
    label: "API baseline analysis",
    value: "Run a 20 second baseline test with 20 users against /products to establish normal performance.",
  },
  {
    label: "Endpoint bottleneck discovery",
    value:
      "Test /products, /products/{product_id}, and /checkout evenly with 30 users for 20 seconds and tell me which endpoint is slowest.",
  },
];

export function MissionComposer({
  disabled,
  onSubmit,
  knownEndpoints,
}: {
  disabled: boolean;
  onSubmit: (input: string) => void;
  knownEndpoints: string[];
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (!value.trim() || disabled) return;
    onSubmit(value.trim());
  };

  return (
    <div>
      <div className="rounded-xl border border-[var(--color-hairline)] bg-[var(--color-panel)] p-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          disabled={disabled}
          rows={3}
          placeholder="e.g. Simulate realistic traffic on my ecommerce API, mostly browsing with a few checkouts, keep p95 under 1s…"
          className="w-full resize-none bg-transparent px-4 py-3 text-[15px] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
            <Sparkles size={12} />
            <span className="font-mono">⌘ + Enter to send</span>
          </div>
          <button
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--color-signal)] px-4 py-2 text-[13px] font-medium text-[#001018] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:brightness-100"
          >
            Initialize evaluation
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            disabled={disabled}
            onClick={() => setValue(chip.value)}
            className="rounded-full border border-[var(--color-hairline)] bg-[var(--color-panel)] px-3 py-1.5 text-[12px] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-signal)]/40 hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            {chip.label}
          </button>
        ))}
      </div>

      {knownEndpoints.length > 0 && (
        <div className="mt-5 flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
          <span>Known target surface:</span>
          <div className="flex flex-wrap gap-1.5 font-mono">
            {knownEndpoints.map((e) => (
              <span key={e} className="rounded border border-[var(--color-hairline)] px-1.5 py-0.5">
                {e}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
