const COLORS: Record<string, string> = {
  success: "bg-[var(--color-success)] shadow-[0_0_8px_var(--color-success)]",
  signal: "bg-[var(--color-signal)] shadow-[0_0_8px_var(--color-signal)]",
  warning: "bg-[var(--color-warning)] shadow-[0_0_8px_var(--color-warning)]",
  danger: "bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]",
  muted: "bg-[var(--color-muted)]",
};

export function StatusDot({ tone, pulse = false }: { tone: keyof typeof COLORS; pulse?: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${COLORS[tone]}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${COLORS[tone]}`} />
    </span>
  );
}
