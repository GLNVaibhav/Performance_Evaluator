import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Build-time immutable identity for the reproducibility manifest
// (src/convex/versionManifest.ts). When the build runs inside a git
// checkout the commit is baked in; otherwise it stays UNKNOWN — never
// inferred. Best-effort by design: a missing git binary/checkout must
// never break the build.
function gitIdentity(): { __GIT_COMMIT__?: string; __GIT_COMMIT_TIME__?: string } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const time = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return commit ? { __GIT_COMMIT__: commit, __GIT_COMMIT_TIME__: time || undefined } : {};
  } catch {
    return {};
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: gitIdentity(),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@convex": path.resolve(__dirname, "./src/convex"),
    },
  },
  server: {
    host: "0.0.0.0",
    hmr: false,
    allowedHosts: true,
  },
});
