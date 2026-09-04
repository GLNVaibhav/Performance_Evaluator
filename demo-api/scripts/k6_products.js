import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  duration: '15s',
};

const BASE = __ENV.DEMO_BASE_URL || 'http://127.0.0.1:8080';

export default function () {
  const r = http.get(`${BASE}/products`);
  check(r, {
    'status 2xx': (res) => res.status >= 200 && res.status < 300,
  });
}
