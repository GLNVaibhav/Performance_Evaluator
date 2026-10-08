/**
 * Execution-plane ingress relay (deployment stand-in).
 *
 * The sandbox has no public ingress (verified in Phase 0), so this relay
 * plays the role the real deployment architecture assigns to a public
 * tunnel/load balancer: it listens on 0.0.0.0 (where Convex cloud CAN reach
 * the sandbox) and forwards every request to the FastAPI execution plane on
 * localhost. In production, EXECUTION_BRIDGE_URL points at the tunnel instead
 * of this process — nothing else changes.
 *
 * Usage: bun scripts/execution-relay.mjs   (LISTEN_PORT default 8002, UPSTREAM default http://127.0.0.1:8000)
 */
import http from "node:http";

const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8002);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8000";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  try {
    const upstreamRes = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection"].includes(k))),
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(150_000),
    });
    const resBody = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
    res.end(resBody);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: `relay upstream error: ${err instanceof Error ? err.message : String(err)}` }));
  }
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`execution relay listening on 0.0.0.0:${LISTEN_PORT} -> ${UPSTREAM}`);
});
