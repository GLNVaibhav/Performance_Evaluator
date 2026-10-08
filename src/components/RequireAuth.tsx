import { useConvexAuth } from "convex/react";
import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-dot" />
          <span className="font-mono text-sm">authenticating…</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?returnTo=${returnTo}`} replace />;
  }

  return <>{children}</>;
}
