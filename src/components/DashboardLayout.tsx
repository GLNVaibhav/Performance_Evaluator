import { Outlet, Link, NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/app", label: "Overview", exact: true },
  { to: "/app/compare", label: "Compare experiments", exact: true },
  { to: "/app/boundary", label: "Boundary search", exact: true },
  { to: "/app/regression", label: "Regression", exact: true },
  { to: "/app/new", label: "New evaluation", exact: true },
];

export default function DashboardLayout() {
  const stats = useQuery(api.queries.stats) ?? { total: 0, active: 0, passed: 0, failed: 0 };
  const userName = useQuery(api.queries.currentUser);
  // Client-side signOut clears the stored credentials; a raw signOut action
  // only touches server state and leaves the browser session alive.
  const { signOut } = useAuthActions();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-60 flex-col border-r border-border/60 glass-panel">
        <div className="flex h-16 items-center gap-2.5 px-5 border-b border-border/50">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 border border-primary/30">
            <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-dot" />
          </span>
          <Link to="/" className="font-semibold tracking-tight">Perforso</Link>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                cn(
                  "block rounded-md px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-border/50 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-md border border-border/60 bg-card/60 p-2">
              <div className="text-lg font-semibold font-mono text-emerald-400">{stats.passed}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">pass</div>
            </div>
            <div className="rounded-md border border-border/60 bg-card/60 p-2">
              <div className="text-lg font-semibold font-mono text-red-400">{stats.failed}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">fail</div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {userName?.email ?? "signed in"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                navigate("/");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar */}
        <div className="lg:hidden flex h-14 items-center justify-between border-b border-border/60 px-4 glass-panel">
          <Link to="/app" className="flex items-center gap-2 font-semibold">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse-dot" /> Perforso
          </Link>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => navigate("/app")}>Overview</Button>
            <Button size="sm" onClick={() => navigate("/app/new")}>New run</Button>
          </div>
        </div>
        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
