# Grantex Next.js Starter

Interactive Next.js demo showing the full Grantex authorization consent flow — agent registration, consent UI, token exchange, and audit logging.

## Prerequisites

- Node.js 18+
- A Grantex API key (sign up at [grantex.dev](https://grantex.dev))

## Setup

```bash
cd examples/nextjs-starter
npm install
cp .env.example .env
```

Edit `.env` and set your `GRANTEX_API_KEY`.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Start Demo**.

## How it works

1. **Start Demo** — The app registers a temporary agent and creates an authorization request via `POST /api/authorize`
2. **Consent UI** — You're redirected to the Grantex consent page where you see the agent name, scopes, and approve/deny buttons
3. **Callback** — After approval, Grantex redirects back to `/callback?code=...&state=...`
4. **Token Exchange** — The callback page calls `POST /api/exchange` to swap the authorization code for a grant token
5. **Results** — The callback page displays the grant ID, scopes, truncated JWT, and audit trail

All SDK calls happen server-side in API routes — the API key never reaches the browser.
