"""Regression test for a real, observed integration bug: the frontend
(a different browser origin -- Vite's dev server, http://localhost:5173)
reported "network error contacting backend" on every API call, because
this backend had no CORS middleware configured at all. Confirmed via a
real preflight OPTIONS request with an Origin header before the fix:
`405 Method Not Allowed`, no Access-Control-* headers -- exactly what
makes a browser abort the real request and fetch() reject with a generic
TypeError, indistinguishable in the frontend's error handling from a
genuinely unreachable server.

Uses TestClient (Starlette's own ASGI test client), which -- unlike a
normal requests-style client -- does NOT strip an explicit `Origin`
header, so CORSMiddleware sees and responds to it exactly as it would for
a real browser request.
"""
from app.core.config import CORS_ALLOWED_ORIGINS

_KNOWN_ORIGIN = "http://localhost:5173"


def test_configured_origins_include_the_frontends_actual_dev_server():
    assert "http://localhost:5173" in CORS_ALLOWED_ORIGINS
    assert "http://127.0.0.1:5173" in CORS_ALLOWED_ORIGINS


def test_preflight_for_a_known_origin_is_allowed(client):
    resp = client.options(
        "/api/v1/intents/interpret",
        headers={
            "Origin": _KNOWN_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == _KNOWN_ORIGIN
    assert "POST" in resp.headers["access-control-allow-methods"]


def test_actual_response_carries_the_allow_origin_header_for_a_known_origin(client):
    """This is the header a real browser checks on the ACTUAL response
    (not just the preflight) before letting JS see it -- its absence is
    exactly what silently manifests as "network error" in the frontend."""
    resp = client.get("/api/v1/health", headers={"Origin": _KNOWN_ORIGIN})
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == _KNOWN_ORIGIN


def test_unlisted_origin_gets_no_allow_origin_header(client):
    """Proves this is a real explicit allow-list, never a wildcard --
    an arbitrary untrusted origin must not be granted access."""
    resp = client.get("/api/v1/health", headers={"Origin": "http://evil.example.com"})
    assert resp.status_code == 200  # the request itself still succeeds server-side
    assert "access-control-allow-origin" not in resp.headers  # but the browser would block reading it
