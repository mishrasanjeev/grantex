# Self-Hosting Grantex

This guide walks through running the Grantex auth service locally or on your own infrastructure using Docker Compose.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/) v2 (ships with Docker Desktop)

---

## Quick Start

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex
docker compose up --build
```

This starts three services:

| Service | Port | Description |
|---------|------|-------------|
| `auth-service` | `3001` | Token issuance, verification, revocation, audit |
| `postgres` | `5432` | Primary database |
| `redis` | `6379` | Revocation cache + session state |

The database schema is applied automatically on first boot via `docker-entrypoint-initdb.d`. Subsequent starts reuse the named volume `postgres_data` and skip the init scripts.

Verify it's running:

```bash
curl http://localhost:3001/health
# → {"status":"ok"}

curl http://localhost:3001/.well-known/jwks.json
# → {"keys":[{"kty":"RSA","alg":"RS256",...}]}
```

---

## Default Dev Credentials

The compose file seeds a developer account on first start:

| Setting | Value |
|---------|-------|
| API key | `dev-api-key-local` |
| Authorization header | `Bearer dev-api-key-local` |

Use this key for all authenticated API calls during local development:

```bash
curl -X POST http://localhost:3001/v1/agents \
  -H "Authorization: Bearer dev-api-key-local" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","scopes":["calendar:read"]}'
```

---

## Environment Variables

All variables are set in the `auth-service` block of `docker-compose.yml`.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `RSA_PRIVATE_KEY` | One of these | PEM-encoded RS256 private key |
| `AUTO_GENERATE_KEYS` | One of these | Set `"true"` to generate keys on startup (dev only) |
| `SEED_API_KEY` | No | If set, creates a developer account with this key on first start |
| `PORT` | No | HTTP port (default: `3001`) |
| `HOST` | No | Bind address (default: `0.0.0.0`) |
| `JWT_ISSUER` | No | `iss` claim in issued tokens (default: `https://grantex.dev`) |

---

## Production Setup

### 1. Provide a real RSA key

`AUTO_GENERATE_KEYS=true` generates a new key pair on every container restart, which invalidates all previously issued tokens. For any persistent deployment, generate a key once and supply it:

```bash
# Generate a 2048-bit RSA private key
openssl genrsa -out grantex-private.pem 2048
```

Set it in your environment (never commit it):

```bash
export RSA_PRIVATE_KEY="$(cat grantex-private.pem)"
```

In `docker-compose.yml`, replace `AUTO_GENERATE_KEYS`:

```yaml
auth-service:
  environment:
    RSA_PRIVATE_KEY: "${RSA_PRIVATE_KEY}"
    # Remove AUTO_GENERATE_KEYS
```

### 2. Use strong database credentials

Replace the default `grantex/grantex` credentials:

```yaml
postgres:
  environment:
    POSTGRES_DB: grantex
    POSTGRES_USER: grantex_prod
    POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"   # from env or secrets manager
```

Update `DATABASE_URL` accordingly:

```yaml
auth-service:
  environment:
    DATABASE_URL: "postgres://grantex_prod:${POSTGRES_PASSWORD}@postgres:5432/grantex"
```

### 3. Remove `SEED_API_KEY`

The seed key is for local development only. In production, create developer accounts via the API or admin tooling.

### 4. Set `JWT_ISSUER`

Set this to a URL you control, used as the `iss` claim in all issued tokens:

```yaml
auth-service:
  environment:
    JWT_ISSUER: "https://auth.yourdomain.com"
```

Clients verifying tokens offline will fetch JWKS from `<JWT_ISSUER>/.well-known/jwks.json`, so ensure this endpoint is publicly reachable.

---

## Running Migrations

The two SQL migration files in `apps/auth-service/src/db/migrations/` are mounted into the postgres container's `docker-entrypoint-initdb.d/` directory and run automatically on first boot (when the data volume is empty).

If you need to apply them to an existing database manually:

```bash
# Via docker compose exec
docker compose exec postgres psql -U grantex -d grantex \
  -f /docker-entrypoint-initdb.d/001_initial.sql

docker compose exec postgres psql -U grantex -d grantex \
  -f /docker-entrypoint-initdb.d/002_spec_compliance.sql

# Or directly against a remote database
psql "$DATABASE_URL" -f apps/auth-service/src/db/migrations/001_initial.sql
psql "$DATABASE_URL" -f apps/auth-service/src/db/migrations/002_spec_compliance.sql
```

---

## Resetting Local State

```bash
# Stop containers and delete the postgres volume (wipes all data)
docker compose down -v

# Restart fresh — migrations re-run automatically
docker compose up --build
```

---

## Ports and Networking

By default all three services bind to `0.0.0.0`. In production, expose only port `3001` externally and keep postgres and redis on an internal network:

```yaml
services:
  postgres:
    ports: []          # remove external binding
  redis:
    ports: []          # remove external binding
  auth-service:
    ports:
      - "3001:3001"
```

Put the auth-service behind a reverse proxy (nginx, Caddy, or a cloud load balancer) for TLS termination.

---

## Health Check

```bash
curl http://localhost:3001/health
```

Returns `200 {"status":"ok"}` when the service is ready to accept requests.
