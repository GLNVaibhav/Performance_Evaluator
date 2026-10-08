import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export default function Auth() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // useAuthActions performs the client-side handshake (setAuth + token
  // persistence) — a raw useAction(api.auth.signIn) only runs the server
  // handler and leaves the browser session unset.
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();

  const returnTo = params.get("returnTo");
  const destination = returnTo && returnTo.startsWith("/") ? returnTo : "/app";

  // Single redirect authority: whenever the reactive auth state reports an
  // authenticated session, go to the destination. This covers both arriving
  // at /auth already signed in and the moment the token from a fresh
  // signIn call is picked up by the Convex client.
  useEffect(() => {
    if (!isAuthenticated) return;
    navigate(destination, { replace: true });
  }, [isAuthenticated, destination, navigate]);

  // Safety net: credentials accepted but the client session never
  // initialized (e.g. deployment/client URL mismatch) → say so instead of
  // silently sitting on the form.
  useEffect(() => {
    if (!redirecting) return;
    const timer = setTimeout(() => {
      setRedirecting(false);
      setBusy(false);
      setError(
        "Credentials were accepted but the session failed to initialize. " +
          "This usually means the app is pointing at the wrong Convex deployment. " +
          "Refresh the page and try again.",
      );
    }, 10_000);
    return () => clearTimeout(timer);
  }, [redirecting]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn("password", {
        flow: mode === "signUp" ? "signUp" : "signIn",
        email: email.trim(),
        password,
        ...(mode === "signUp" ? { name: name.trim() || email.split("@")[0] } : {}),
      });
      // Tokens are now stored client-side; isAuthenticated will flip and the
      // effect above performs the redirect to the destination route.
      setRedirecting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      <div className="absolute inset-0 grid-bg opacity-50 pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,hsl(var(--background))_75%)] pointer-events-none" />
      <div className="relative w-full max-w-md px-6">
        <Link to="/" className="flex items-center justify-center gap-2.5 mb-8">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 border border-primary/30">
            <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-dot" />
          </span>
          <span className="font-semibold tracking-tight text-xl">Perforso</span>
        </Link>
        <div className="rounded-xl border border-border/70 glass-panel p-7 shadow-2xl">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === "signIn" ? "Mission control access" : "Create your console"}
            </h1>
            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
              {mode === "signIn" ? "auth" : "register"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-6">
            {mode === "signIn"
              ? "Sign in to run evaluations against your targets."
              : "An account keeps your run history and results."}
          </p>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signUp" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dev" autoComplete="name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.dev"
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === "signUp" ? "new-password" : "current-password"}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? redirecting
                  ? "Signed in — redirecting…"
                  : "Authenticating…"
                : mode === "signIn"
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>

          <div className="mt-5 text-center text-sm text-muted-foreground">
            {mode === "signIn" ? (
              <>
                No account?{" "}
                <button className="text-primary hover:underline" onClick={() => { setMode("signUp"); setError(null); }}>
                  Create one
                </button>
              </>
            ) : (
              <>
                Already registered?{" "}
                <button className="text-primary hover:underline" onClick={() => { setMode("signIn"); setError(null); }}>
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
        <p className="mt-6 text-center font-mono text-[11px] text-muted-foreground">
          intent → compile → approve → execute → explain
        </p>
      </div>
    </div>
  );
}
