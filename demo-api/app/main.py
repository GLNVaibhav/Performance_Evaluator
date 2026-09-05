from fastapi import FastAPI

from app.routes import auth, cart, categories, checkout, demo, products

app = FastAPI(
    title="Performance Evaluator Demo API",
    description=(
        "Canonical e-commerce demo target for autonomous performance evaluation. "
        "Provides deterministic in-memory data and runtime performance modes."
    ),
    version="1.0.0",
)

app.include_router(auth.router)
app.include_router(products.router)
app.include_router(categories.router)
app.include_router(cart.router)
app.include_router(checkout.router)
app.include_router(demo.router)
