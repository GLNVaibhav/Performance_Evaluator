from typing import Dict, List

from app.models import Product

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
