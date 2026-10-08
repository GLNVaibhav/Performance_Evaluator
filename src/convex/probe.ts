/**
 * Bounded real-HTTP traffic probe — the "real target validation" engine.
 *
 * What this is: a small, safe, evidence-collecting HTTP probe. It proves a
 * target is reachable and measures real latency/status/error behaviour under
 * a bounded synthetic load (≤ MAX_REQUESTS requests, ≤ MAX_BURST in flight,
 * ≤ MAX_DURATION_MS wall clock, GET-only).
 *
 * What this is NOT: the k6 load engine (backend/). It cannot sustain VU
 * populations, cannot find breaking points, and does not do stateful
 * POST/checkout flows. Those require real k6 execution.
 *
 * Safety contract:
 *  - GET-only, no bodies, honest User-Agent, jittered volleys
 *  - every hop (initial URL and each redirect) is scheme-validated and
 *    host-validated against private/link-local ranges, with real DNS
 *    resolution via DNS-over-HTTPS where available (see validateHost)
 *  - k6-equivalent measurement semantics: latency percentiles cover every
 *    COMPLETED response regardless of status (k6's http_req_duration);
 *    network-level failures (no response at all) are excluded from latency
 *    stats but counted as failures (k6's http_req_failed); status 0 means
 *    "no HTTP response received" (k6's convention).
 */

import { latencyStats } from "./percentile";

export const MAX_REQUESTS = 30;
export const MAX_BURST = 4;
export const MAX_DURATION_MS = 8_000;
const REQUEST_TIMEOUT_MS = 4_000;
const VOLLEY_GAP_MS = 120;
const MAX_REDIRECTS = 3;

/** Injectable network layer — tests swap this for a deterministic fake. */
export interface ProbeDeps {
  /** Perform one HTTP GET (any redirect handling is done by the probe). */
  fetchImpl?: typeof fetch;
  /** Wall clock in ms. */
  now?: () => number;
  /** Delay helper (setTimeout by default). */
  sleep?: (ms: number) => Promise<void>;
  /** Bypasses/overrides host safety checks in tests. */
  hostValidator?: (hostname: string) => Promise<void>;
}

const defaultDeps: Required<Pick<ProbeDeps, "now" | "sleep">> & { fetchImpl?: typeof fetch; hostValidator?: ProbeDeps["hostValidator"] } = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// --- Host safety ------------------------------------------------------------
// Mirrors backend/app/services/target_url_safety.py's policy classes:
// cloud metadata / link-local are ALWAYS blocked; private/loopback are
// blocked for this Convex engine because (unlike the Python backend) it has
// no local demo target use case and runs in a shared cloud environment.

const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254", // AWS/GCP/Azure metadata
  "100.100.100.200", // Alibaba Cloud metadata
  "metadata.google.internal",
]);

function ipv4Blocked(ip: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((o) => o > 255)) return "malformed IPv4";
  if (a === 127) return "loopback";
  if (a === 10) return "private (10/8)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16/12)";
  if (a === 192 && b === 168) return "private (192.168/16)";
  if (a === 169 && b === 254) return "link-local / cloud metadata";
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT (100.64/10)";
  if (a === 0) return "this-network (0/8)";
  return null;
}

function ipv6Blocked(raw: string): string | null {
  const ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip === "::1" || ip === "::") return "IPv6 loopback/unspecified";
  if (/^f[cd]/.test(ip)) return "IPv6 unique-local (fc00::/7)";
  if (/^fe[89ab]/.test(ip)) return "IPv6 link-local (fe80::/10)";
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return ipv4Blocked(mapped[1]) ? `IPv4-mapped ${mapped[1]}` : null;
  return null;
}

/** Textual/IP-literal host check. Always applied; DNS check adds depth. */
export function isBlockedHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "empty hostname";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "localhost-style hostname";
  }
  if (BLOCKED_HOSTNAMES.has(host)) return "cloud metadata endpoint";
  return ipv4Blocked(host) ?? ipv6Blocked(host);
}

/**
 * DNS-level validation via DNS-over-HTTPS (no Node built-ins exist in the
 * Convex runtime). Resolves A/AAAA and rejects when ANY resolved address is
 * private/link-local. DoH being unavailable is NOT treated as "dangerous"
 * (same asymmetry as target_url_safety.py: can't-verify ≠ verified-dangerous)
 * — textual/IP checks above still apply. Bounded to one request per host.
 */
const dohCache = new Map<string, boolean>(); // hostname -> validated-ok
export async function validateHostResolvesSafely(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHost(host)) {
    throw new Error(`probe host ${JSON.stringify(host)} is blocked (${isBlockedHost(host)})`);
  }
  // IP literals need no DNS.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return;
  if (dohCache.get(host)) return;

  let ok = false;
  try {
    for (const type of ["A", "AAAA"] as const) {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(2_500),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: { data: string }[] };
      for (const answer of data.Answer ?? []) {
        const reason = ipv4Blocked(answer.data) ?? ipv6Blocked(answer.data);
        if (reason) {
          throw new Error(`probe host ${JSON.stringify(host)} resolves to a blocked address (${reason})`);
        }
      }
      if (type === "A" && (data.Answer?.length ?? 0) > 0) ok = true;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("blocked address")) throw err;
    // DoH unavailable — proceed on textual checks (documented asymmetry).
  }
  dohCache.set(host, ok || true);
}

/** Full URL validation: scheme + host checks (textual, IP, and DNS). */
export async function assertSafeProbeUrl(
  raw: string,
  hostValidator: (hostname: string) => Promise<void> = validateHostResolvesSafely,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid target URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("probe URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("probe URL must not embed credentials (user:pass@host)");
  }
  await hostValidator(url.hostname);
  return url;
}

// --- Path handling ------------------------------------------------------------

function normalizePath(path: string): string {
  const trimmed = (path ?? "/").trim();
  if (!trimmed.startsWith("/")) return "/";
  // Collapse k6-style path params (e.g. /products/{id}) to their collection
  // root so probes never guess identifiers — /products/{id} probes /products.
  const braced = trimmed.indexOf("{");
  if (braced > 1) return trimmed.slice(0, braced).replace(/\/+$/, "") || "/";
  return trimmed;
}

export function probeUrlSet(baseUrl: string, endpoints: string[]): string[] {
  const base = new URL(baseUrl); // already validated by assertSafeProbeUrl upstream
  const paths = endpoints.length ? endpoints.slice(0, 5) : ["/"];
  const urls = paths.map((p) => {
    const u = new URL(base.toString());
    u.pathname = normalizePath(p);
    u.username = "";
    u.password = "";
    return u.toString();
  });
  return [...new Set(urls)];
}

// --- Measurement ----------------------------------------------------------------

export type ProbeErrorKind = "timeout" | "connection" | "redirect" | "blocked" | "other";

export interface ProbeEvent {
  tMs: number; // elapsed since probe start
  latencyMs: number; // completed responses only; 0 semantics documented below
  status: number; // HTTP status, or 0 = no response received (k6 convention)
  ok: boolean; // 2xx
  error: string | null; // non-null only for network-level failures
  errorKind: ProbeErrorKind | null;
}

export interface ProbeResult {
  reachable: boolean;
  /** Latency of every COMPLETED response, regardless of status (k6 http_req_duration semantics). */
  latenciesMs: number[];
  statuses: number[]; // every completed response's status
  networkErrors: number; // no response at all (timeout, refused, DNS, blocked hop)
  http4xx: number;
  http5xx: number;
  totalRequests: number;
  probeUrls: string[];
  errorSample: string | null;
  errorKindCounts: Partial<Record<ProbeErrorKind, number>>;
  events: ProbeEvent[];
  elapsedMs: number;
  /** Measured peak in-flight logical requests (≤ MAX_BURST) — the honest concurrency figure. */
  maxInFlight: number;
}

function classifyError(err: unknown): { kind: ProbeErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "TimeoutError") return { kind: "timeout", message: `timeout after ${REQUEST_TIMEOUT_MS}ms` };
  if (err instanceof Error && err.name === "AbortError") return { kind: "timeout", message: `timeout after ${REQUEST_TIMEOUT_MS}ms` };
  if (/blocked/i.test(message)) return { kind: "blocked", message };
  if (/redirect/i.test(message)) return { kind: "redirect", message };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|certificate|TLS|network/i.test(message)) {
    return { kind: "connection", message };
  }
  return { kind: "other", message };
}

interface HopOutcome {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
  errorKind: ProbeErrorKind | null;
}

/**
 * One timed GET with validated manual redirects. Exported so the endpoint
 * verification layer can spend single bounded GETs on candidate paths.
 */
export async function timedFetchWithRedirects(
  startUrl: string,
  deps: ProbeDeps = {},
): Promise<HopOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hostValidator = deps.hostValidator ?? validateHostResolvesSafely;
  const started = deps.now?.() ?? Date.now();
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual", // every hop is validated — never blindly followed
        signal: controller.signal,
        headers: {
          "User-Agent": "Perforso-Evaluator/1.0 (+bounded synthetic monitoring probe)",
          Accept: "*/*",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.arrayBuffer().catch(() => undefined);
        if (!location) {
          return { ok: false, status: res.status, latencyMs: (deps.now?.() ?? Date.now()) - started, error: `redirect ${res.status} without Location`, errorKind: "redirect" };
        }
        const next = new URL(location, current).toString();
        const nextUrl = new URL(next);
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          return { ok: false, status: 0, latencyMs: (deps.now?.() ?? Date.now()) - started, error: `redirect to unsafe scheme ${nextUrl.protocol}`, errorKind: "blocked" };
        }
        await hostValidator(nextUrl.hostname);
        if (hop === MAX_REDIRECTS) {
          return { ok: false, status: 0, latencyMs: (deps.now?.() ?? Date.now()) - started, error: `more than ${MAX_REDIRECTS} redirects`, errorKind: "redirect" };
        }
        current = next;
        continue;
      }
      await res.arrayBuffer().catch(() => undefined);
      return { ok: res.ok, status: res.status, latencyMs: (deps.now?.() ?? Date.now()) - started, error: null, errorKind: null };
    } catch (err) {
      const { kind, message } = classifyError(err);
      return { ok: false, status: 0, latencyMs: (deps.now?.() ?? Date.now()) - started, error: message, errorKind: kind };
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable (loop above returns on every path).
  return { ok: false, status: 0, latencyMs: (deps.now?.() ?? Date.now()) - started, error: "redirect loop", errorKind: "redirect" };
}

/**
 * One bounded probe volley sequence over `urls` with injected deps.
 * Pure orchestration — the transport is whatever `deps.fetchImpl` is.
 */
export async function runProbeVolley(
  urls: string[],
  maxRequests: number,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hostValidator = deps.hostValidator ?? validateHostResolvesSafely;
  const result: ProbeResult = {
    reachable: false,
    latenciesMs: [],
    statuses: [],
    networkErrors: 0,
    http4xx: 0,
    http5xx: 0,
    totalRequests: 0,
    probeUrls: urls,
    errorSample: null,
    errorKindCounts: {},
    events: [],
    elapsedMs: 0,
    maxInFlight: 0,
  };
  const started = now();
  // Measured concurrency: logical requests in flight at once (redirect hops
  // within one logical request are sequential and do not inflate this).
  let inFlight = 0;
  const track = async (p: Promise<HopOutcome>): Promise<HopOutcome> => {
    inFlight += 1;
    result.maxInFlight = Math.max(result.maxInFlight, inFlight);
    try {
      return await p;
    } finally {
      inFlight -= 1;
    }
  };
  const record = (r: HopOutcome) => {
    result.totalRequests += 1;
    result.events.push({
      tMs: now() - started,
      latencyMs: r.latencyMs,
      status: r.status,
      ok: r.ok,
      error: r.error,
      errorKind: r.errorKind,
    });
    if (r.error) {
      result.networkErrors += 1;
      result.errorKindCounts[r.errorKind ?? "other"] = (result.errorKindCounts[r.errorKind ?? "other"] ?? 0) + 1;
      result.errorSample ??= r.error;
    } else {
      result.statuses.push(r.status);
      result.latenciesMs.push(r.latencyMs);
      if (r.status >= 400 && r.status < 500) result.http4xx += 1;
      if (r.status >= 500) result.http5xx += 1;
    }
  };

  let cursor = 0;
  const nextUrl = () => {
    const u = urls[cursor % urls.length];
    cursor += 1;
    return u;
  };

  const initial = await track(timedFetchWithRedirects(nextUrl(), deps));
  record(initial);
  if (initial.error) {
    result.elapsedMs = now() - started;
    return result;
  }
  result.reachable = true;

  while (result.totalRequests < maxRequests && now() - started < MAX_DURATION_MS) {
    const batch = Math.max(1, Math.min(MAX_BURST, maxRequests - result.totalRequests));
    const responses = await Promise.all(
      Array.from({ length: batch }, () => track(timedFetchWithRedirects(nextUrl(), deps))),
    );
    for (const r of responses) record(r);
    // Jittered inter-volley gap — but never after the final volley (would
    // inflate measured wall-clock without producing traffic).
    if (result.totalRequests < maxRequests && now() - started < MAX_DURATION_MS) {
      await sleep(VOLLEY_GAP_MS + Math.random() * 80);
    }
  }

  result.elapsedMs = now() - started;
  return result;
}

export async function probeTarget(baseUrl: string, endpoints: string[], deps: ProbeDeps = {}): Promise<ProbeResult> {
  const urls = probeUrlSet(baseUrl, endpoints);
  await assertSafeProbeUrl(urls[0], deps.hostValidator);
  return runProbeVolley(urls, MAX_REQUESTS, deps);
}

/** Aggregate latency statistics (k6-style: linear-interpolation percentiles, avg, max). */
export function summarizeLatencies(samples: number[]): {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
  count: number;
} {
  return latencyStats(samples);
}
