import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

/**
 * Non-secret fallback: the cloud Convex deployment this app is wired to.
 * Used only when the build-time env var is missing/malformed in production,
 * so a bad hosting env var can never brick the deployed app again.
 */
const FALLBACK_CONVEX_URL = "https://brilliant-mastiff-710.convex.cloud";

function isUsableConvexUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (import.meta.env.PROD && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve and validate the Convex backend URL at boot.
 * Dev: a bad value fails loudly (you are at your machine).
 * Prod: a bad value falls back to the bundled deployment URL so the site
 * keeps working; the console carries a warning for diagnosis.
 */
function resolveConvexUrl(): string {
  const raw = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (isUsableConvexUrl(raw)) return raw;
  if (import.meta.env.DEV) {
    throw new Error(
      `VITE_CONVEX_URL is not set or invalid (received: "${raw ?? "unset"}"). ` +
        "Run `convex dev` to configure it.",
    );
  }
  console.warn(
    `[perforso] VITE_CONVEX_URL invalid ("${raw ?? "unset"}") — using bundled deployment URL ${FALLBACK_CONVEX_URL}`,
  );
  return FALLBACK_CONVEX_URL;
}

function BootError({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm leading-relaxed">
        <div className="mb-2 font-mono text-xs uppercase tracking-widest text-red-400">boot failure</div>
        <p className="text-foreground">{message}</p>
        <p className="mt-3 text-muted-foreground">
          Deployments read env vars at build time — update the environment and redeploy.
        </p>
      </div>
    </div>
  );
}

let convexUrl: string;
try {
  convexUrl = resolveConvexUrl();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  createRoot(document.getElementById("root")!).render(<BootError message={message} />);
  throw err;
}

const convex = new ConvexReactClient(convexUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexAuthProvider>
    </ConvexProvider>
  </StrictMode>,
);
