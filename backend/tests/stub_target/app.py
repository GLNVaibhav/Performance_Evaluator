"""Throwaway target app used ONLY by Phase-1 backend tests to prove the
execution pipeline end to end. This is NOT the canonical demo e-commerce
API (that is Developer 4's deliverable: /login, /products, /products/{id},
/cart, /checkout, /demo/mode). Delete this once the canonical demo API
exists and point tests at that instead.
"""

from fastapi import FastAPI

app = FastAPI()


@app.get("/products")
def products():
    return {"products": [{"id": 1, "name": "widget"}]}


@app.post("/checkout")
def checkout():
    return {"status": "ok"}
