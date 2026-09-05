from typing import Dict, List

from app.models import Category, Product

PRODUCTS: List[Product] = [
    Product(id=1, name="Laptop", price=799.99, category="electronics", inventory=10),
    Product(id=2, name="Wireless Mouse", price=29.99, category="electronics", inventory=50),
    Product(id=3, name="Mechanical Keyboard", price=89.99, category="electronics", inventory=25),
    Product(id=4, name="USB-C Hub", price=49.99, category="accessories", inventory=40),
    Product(id=5, name="Monitor Stand", price=39.99, category="accessories", inventory=30),
    Product(id=6, name="Noise Cancelling Headphones", price=199.99, category="audio", inventory=15),
    Product(id=7, name="Webcam HD", price=59.99, category="electronics", inventory=20),
    Product(id=8, name="Desk Lamp", price=24.99, category="office", inventory=35),
]

PRODUCTS_BY_ID: Dict[int, Product] = {product.id: product for product in PRODUCTS}

# Derived from the existing Product.category strings (not a separate,
# hand-maintained taxonomy that could drift out of sync) -- gives the
# catalog a real relational shape (Category 1..N -> Products) for weighted
# read-heavy traffic without inventing unrelated data.
CATEGORIES: List[Category] = [
    Category(id=1, name="electronics", description="Computers, peripherals, and electronic accessories"),
    Category(id=2, name="accessories", description="General accessories and add-ons"),
    Category(id=3, name="audio", description="Headphones and audio equipment"),
    Category(id=4, name="office", description="Office and desk equipment"),
]

CATEGORIES_BY_ID: Dict[int, Category] = {category.id: category for category in CATEGORIES}
