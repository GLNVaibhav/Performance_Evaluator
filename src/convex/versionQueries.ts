/**
 * Public version manifest query (Phase 11). Unauthenticated by design:
 * the manifest carries version identities and configuration NAMES only —
 * never secret values. Deterministic: same environment → same output.
 */
import { query } from "./_generated/server";
import { buildVersionManifest } from "./versionManifest";

export const versionManifest = query({
  args: {},
  handler: async () => buildVersionManifest(),
});
