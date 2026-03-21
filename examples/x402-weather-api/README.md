# x402 Weather API Example

Express server demonstrating x402 payment flow + GDT (Grantex Delegation Token) enforcement.

## Run

```bash
npm install
npm start
```

Server starts on `http://localhost:3402`. On startup, it generates demo keys and a sample GDT token.

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Health check |
| `GET /api/weather/status` | None | Service status & pricing |
| `GET /api/weather/forecast` | x402 + GDT | Weather forecast (costs 0.001 USDC) |
| `GET /api/audit` | None | View audit log |

## Flow

1. Request without payment → `402 Payment Required`
2. Request with payment but no GDT → `403 Forbidden`
3. Request with payment + valid GDT → `200 OK` with weather data
