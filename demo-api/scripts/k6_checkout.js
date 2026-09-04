import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 5,
  duration: '10s',
};

const BASE = __ENV.DEMO_BASE_URL || 'http://127.0.0.1:8080';

export default function () {
  const cart = http.post(
    `${BASE}/cart`,
    JSON.stringify({ product_id: 1, quantity: 1 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (cart.status !== 200) {
    return;
  }
  const cartId = cart.json('cart_id');
  const checkout = http.post(
    `${BASE}/checkout`,
    JSON.stringify({ cart_id: cartId }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(checkout, {
    'checkout status 2xx': (res) => res.status >= 200 && res.status < 300,
  });
}
