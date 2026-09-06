import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Activity, Compass, History, LayoutGrid, Radar } from "lucide-react";
import { StatusDot } from "../common/StatusDot";
import { checkHealth } from "../../api/client";

const NAV = [
  { to: "/", label: "Mission Control", icon: Radar },
  { to: "/history", label: "Run History", icon: History },
  { to: "/architecture", label: "Architecture", icon: LayoutGrid },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      const ok = await checkHealth();
      if (mounted) setOnline(ok);
    };
    poll();
    const id = window.setInterval(poll, 8000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-screen bg-[var(--color-base)] bg-grid text-[var(--color-ink)]">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-hairline)] bg-[var(--color-panel)]/60 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-signal-dim)] text-[var(--color-signal)]">
            <Activity size={16} strokeWidth={2.5} />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">Performance Evaluator</div>
            <div className="text-[10px] text-[var(--color-ink-dim)]">AI Performance Intelligence</div>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-3 py-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                  isActive
                    ? "bg-[var(--color-panel-raised)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-raised)]/60 hover:text-[var(--color-ink)]"
                }`
              }
            >
              <Icon size={15} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto border-t border-[var(--color-hairline)] px-4 py-3">
          <div className="flex items-center gap-2 text-[12px]">
            <StatusDot tone={online ? "success" : online === false ? "danger" : "muted"} pulse={!!online} />
            <span className="text-[var(--color-ink-dim)]">
              {online === null ? "Checking backend…" : online ? "Backend connected" : "Backend unreachable"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 pl-4 font-mono text-[10px] text-[var(--color-muted)]">
            <Compass size={10} />
            127.0.0.1:8000
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
