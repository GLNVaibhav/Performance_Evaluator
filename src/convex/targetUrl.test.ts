/**
 * Regression tests: target base-URL normalization at the createRun safety
 * gate (src/convex/mutations.ts::validateTargetUrlSafety).
 *
 * Incident (Phase 1 product-path validation, 2026-09-27): the gate returned
 * `url.toString()`, and WHATWG URL serialization appends "/" whenever the
 * pathname is empty — "http://127.0.0.1:8080" became
 * "http://127.0.0.1:8080/". The k6 script renderer joins BASE_URL + endpoint,
 * so every request hit "//products" and the live run recorded 50/50 HTTP 404s
 * as a COMPLETED+FAIL performance result. The local e2e missed it because it
 * passes the raw URL to serializePlan directly, bypassing this gate.
 *
 * Run: bun test src/convex/targetUrl.test.ts
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, expect, test } from "bun:test";

import { validateTargetUrlSafety } from "./mutations";
import { serializePlan } from "./executor/contract";
import type { ConvexTestPlan } from "./executor/contract";

const PLAN: ConvexTestPlan = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "5s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: [],
};

describe("target URL normalization (Phase 1 product-path regression)", () => {
  test("a pathless base URL keeps NO trailing slash — k6 joins base + endpoint", () => {
    // Before the fix: "http://127.0.0.1:8080/" (→ //products → 404 on every request).
    expect(validateTargetUrlSafety("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(validateTargetUrlSafety("https://api.example.com")).toBe("https://api.example.com");
  });

  test("meaningful stored paths are preserved untouched", () => {
    expect(validateTargetUrlSafety("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(validateTargetUrlSafety("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });

  test("the serialized execution request carries the normalized base_url", () => {
    // Full composition: the exact URL the executor submits must render as
    // BASE_URL = "http://127.0.0.1:8080" in the generated k6 script.
    const request = serializePlan(PLAN, validateTargetUrlSafety("http://127.0.0.1:8080"), "c", "x");
    expect(request.target.base_url).toBe("http://127.0.0.1:8080");
    expect(request.target.base_url.endsWith("/")).toBe(false);
  });

  test("all pre-existing safety gates still hold after the normalization change", () => {
    expect(() => validateTargetUrlSafety("not a url")).toThrow(/Invalid target URL/);
    expect(() => validateTargetUrlSafety("ftp://example.com")).toThrow(/http or https/);
    expect(() => validateTargetUrlSafety("http://user:pass@example.com/")).toThrow(/credentials/);
    expect(() => validateTargetUrlSafety("http://169.254.169.254/")).toThrow(/blocked/);
  });
});
