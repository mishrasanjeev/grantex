# Grantex Deployment Guide

Complete guide to deploying the Grantex authorization platform in your environment.

---

## System Requirements

| Component | Minimum | Recommended | Purpose |
|-----------|---------|-------------|---------|
| **Node.js** | 18.0.0 | 20 LTS | Auth service, CLI, TypeScript packages |
| **Python** | 3.9 | 3.12+ | Python SDK, FastAPI middleware, integrations |
| **Go** | 1.26.1 | 1.26.1+ | Go SDK (the Terraform provider currently requires 1.25+) |
| **PostgreSQL** | 14 | 16 | Primary database |
| **Redis** | 6 | 7+ | Caching, rate limiting, pub/sub, revocation |
| **Docker** | 20.10+ | 24+ | Containerized deployment (optional) |
| **OS** | Linux (Ubuntu 22.04+), macOS 13+, Windows 11 | Ubuntu 24.04 LTS | Any |
| **Memory** | 512MB | 2GB+ | Auth service + DB + Redis |
| **Disk** | 1GB | 10GB+ | Database storage, logs |

---

## Deployment Files

| File | Purpose |
|------|---------|
| `DEPLOYMENT.md` | This guide |
| `requirements.txt` | Python package dependencies |
| `docker-compose.yml` | Dev stack (auth service + PostgreSQL + Redis) |
| `docker-compose.prod.yml` | Production Docker stack |
| `apps/auth-service/Dockerfile` | Auth service container image |
| `apps/auth-service/.env.example` | Baseline environment template; `src/config.ts` is authoritative |
| `apps/auth-service/package.json` | Node.js dependencies |
| `apps/auth-service/package-lock.json` | Pinned Node.js dependencies |
| `apps/auth-service/src/db/migrations/` | Ordered SQL migrations (currently through `063`) |
| `packages/gateway/Dockerfile` | Gateway reverse proxy container |
| `deploy/gcp/setup.sh` | Google Cloud Run setup |
| `deploy/gcp/setup-wif.sh` | Workload Identity Federation setup |
| `deploy/gcp/dns.sh` | DNS configuration |
| `deploy/helm/grantex/` | Kubernetes Helm chart (14 files) |
| `deploy/helm/grantex/values.yaml` | Helm default values |
| `deploy/nginx/nginx.conf` | Nginx reverse proxy config |
| `deploy/grafana/` | 2 Grafana dashboard JSON files |
| `firebase.json` | Firebase Hosting config (portal + landing page) |
| `.zap/rules.tsv` | OWASP ZAP security scan rules |
| `.github/workflows/deploy.yml` | CI/CD deploy to Cloud Run |
| `.github/workflows/deploy-portal.yml` | CI/CD deploy portal to Firebase |

---

## Quick Start (Docker Compose)

The fastest way to run the full stack:

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex
docker compose up -d
```

This starts:
- Auth service on port 3001
- PostgreSQL on port 5432
- Redis on port 6379

---

## Manual Deployment

### Step 1: Database

```bash
# PostgreSQL 16
sudo apt install postgresql-16
sudo -u postgres createdb grantex
sudo -u postgres psql -c "CREATE USER grantex WITH PASSWORD 'your-secure-password';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE grantex TO grantex;"
```

### Step 2: Redis

```bash
# Redis 7
sudo apt install redis-server
sudo systemctl enable redis-server
```

### Step 3: Auth Service

```bash
cd apps/auth-service

# Copy and edit environment variables
cp .env.example .env
# Edit .env — set DATABASE_URL, REDIS_URL, RSA_PRIVATE_KEY, JWT_ISSUER
# See "Environment Variables" section below for all options

npm ci
npm run build

# Run migrations
npm run migrate

# Start
NODE_ENV=production npm start
```

The service starts on port 3001 by default.

### Step 4: Verify

```bash
curl http://localhost:3001/health
# {"status":"healthy","database":"ok","redis":"ok"}
```

---

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/grantex` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_ISSUER` | JWT issuer claim (your domain) | `https://auth.example.com` |
| `RSA_PRIVATE_KEY` | RSA private key (PEM format) for JWT signing | `-----BEGIN RSA PRIVATE KEY-----...` |
| `ADMIN_API_KEY` | Strong key protecting `/v1/admin/*` endpoints (required in production) | 32+ random bytes |
| `VAULT_ENCRYPTION_KEY` | 32-byte hex or base64 key for credential-vault encryption (required in production) | `openssl rand -hex 32` |
| `METRICS_API_KEY` | Key protecting `/metrics` when production metrics are enabled | 32+ random bytes |

> **Note:** Set `AUTO_GENERATE_KEYS=true` instead of `RSA_PRIVATE_KEY` for development. The service will generate an ephemeral RSA key pair on startup. **Do not use this in production** — keys change on every restart.

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `TRUST_PROXY` | `false` | Trusted proxy hop count (`1`-`16`) or comma-separated IP/CIDR allowlist used to derive the client IP |
| `CORS_ALLOWED_ORIGINS` | `https://grantex.dev,https://portal.grantex.dev,http://localhost:5173` | Comma-separated exact browser origins allowed to call the API; use an empty value to disable cross-origin browser access |
| `NODE_ENV` | `development` | `production` enables optimizations |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `STRIPE_SECRET_KEY` | (none) | Stripe billing integration |
| `STRIPE_WEBHOOK_SECRET` | (none) | Stripe webhook signature verification |
| `STRIPE_PRICE_PRO` | (none) | Stripe price ID for pro plan |
| `STRIPE_PRICE_ENTERPRISE` | (none) | Stripe price ID for enterprise plan |
| `FIDO_RP_ID` | `grantex.dev` | WebAuthn Relying Party ID |
| `FIDO_RP_NAME` | `Grantex` | WebAuthn Relying Party name |
| `FIDO_ORIGIN` | `https://grantex.dev` | WebAuthn origin URL |
| `OPA_URL` | (none) | Open Policy Agent endpoint for policy evaluation |
| `OPA_FALLBACK_TO_BUILTIN` | (none) | Fall back to built-in policy engine if OPA is unavailable |
| `CEDAR_URL` | (none) | Cedar policy engine endpoint |
| `CEDAR_FALLBACK_TO_BUILTIN` | (none) | Fall back to built-in policy engine if Cedar is unavailable |
| `SSO_STATE_SECRET` | (derived from RSA key) | HMAC key for SSO state parameters |
| `RESEND_API_KEY` | (none) | Resend API key for email verification |
| `EMAIL_FROM` | (none) | Sender email address |
| `ED25519_PRIVATE_KEY` | (none) | Ed25519 key for DID/VC operations (optional — auto-generates if not set) |
| `DID_WEB_DOMAIN` | `grantex.dev` | Domain for `did:web:` identifier |
| `METRICS_ENABLED` | `true` | Enable Prometheus metrics endpoint |
| `USAGE_METERING_ENABLED` | `true` | Enable usage metering counters |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (none) | OpenTelemetry collector endpoint |
| `SEED_API_KEY` | (none) | Pre-seed a developer API key on first start |
| `SEED_SANDBOX_KEY` | (none) | Pre-seed a sandbox API key on first start |

### Startup Validation

The service validates required configuration on startup. If `DATABASE_URL`, `REDIS_URL`, or JWT signing key is missing, the process exits with code 1 and logs which values are missing.

### Trusted Proxy Configuration

`TRUST_PROXY` controls whether Fastify may derive `request.ip` from
`X-Forwarded-For`. It is disabled by default, so forwarding headers from direct
clients are ignored. Set it only when the auth service can be reached
exclusively through a proxy chain you control.

The value may be a hop count from `1` to `16` or a comma-separated list of
trusted proxy IP addresses/CIDRs. A numeric value trusts that many closest
network hops. It is safe only when every request follows the same path and a
shorter path cannot reach the service; otherwise a client may supply a
forwarded address that falls inside the trusted distance. Prefer an explicit
IP/CIDR allowlist when proxy addresses are stable. Unrestricted values such as
`true`, `*`, `0.0.0.0/0`, and `::/0` are rejected.

---

## Database

### Connection Pool

The auth service uses connection pooling:

| Setting | Value | Description |
|---------|-------|-------------|
| `max` | 20 | Maximum connections |
| `idle_timeout` | 30s | Close idle connections after 30 seconds |
| `connect_timeout` | 10s | Fail fast on connection issues |
| `max_lifetime` | 30min | Recycle connections every 30 minutes |

### Migrations

Migrations run automatically on first start, or manually:

```bash
cd apps/auth-service
npm run migrate
```

The ordered migrations currently run from `001` through `063` and create the core, enterprise, offline, trust-registry, and commerce data structures. Treat the migration directory—not a copied count in documentation—as authoritative.

### Backup

```bash
pg_dump -U grantex -h localhost grantex > backup.sql
```

---

## Redis

Used for:
- Rate limiting (standard-auth developer/plan counters and explicitly Redis-backed route counters; default Fastify IP/route counters are process-local)
- Token revocation cache (sub-second propagation)
- Event pub/sub (SSE and WebSocket streams)
- Usage metering counters

### Persistence

Enable Redis persistence for revocation data:

```
# redis.conf
appendonly yes
appendfsync everysec
```

### Connection Handling

The service includes error handlers for Redis disconnections and automatic reconnection logging.

---

## Security Checklist

Before deploying to production:

- [ ] Set a real `RSA_PRIVATE_KEY` (do NOT use `AUTO_GENERATE_KEYS` in production)
- [ ] Set `NODE_ENV=production`
- [ ] Set a strong `ADMIN_API_KEY` (required in production)
- [ ] Set a valid 32-byte `VAULT_ENCRYPTION_KEY` (required in production)
- [ ] Set `METRICS_API_KEY`, or explicitly disable metrics with `METRICS_ENABLED=false`
- [ ] Enable TLS termination (via reverse proxy or cloud load balancer)
- [ ] Configure firewall — only expose port 3001 (or your chosen port)
- [ ] Configure `TRUST_PROXY` only for a verified, network-restricted proxy chain
- [ ] Set `CORS_ALLOWED_ORIGINS` to the exact production browser origins that call the API
- [ ] Restrict admin endpoints to internal network / VPN
- [ ] Enable Redis authentication (`requirepass` in redis.conf)
- [ ] Enable PostgreSQL SSL (`sslmode=require` in DATABASE_URL)
- [ ] Set up log aggregation (structured JSON logging via pino)
- [ ] Configure monitoring (Prometheus metrics at `GET /metrics`)
- [ ] Set up alerting on `GET /health` returning 503

### Security Features (built-in)

The auth service includes these security features out of the box:

- Rate limiting: Fastify applies a 5,000/min per-IP default to routes without an override (JWKS exempt), while route-specific Fastify limits replace that default on those routes; Redis additionally enforces Free/Pro/Enterprise budgets of 100/500/2,000 per developer on standard-auth API-key routes
- 7 HTTP security headers (HSTS, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, Cache-Control)
- Timing-safe admin authentication
- HMAC-signed SSO state parameters
- JWT expiry validation
- Scope format validation
- Input sanitization (trimming) on all string fields
- 1MB request body limit
- CORS uses a source default allowlist for `https://grantex.dev`, `https://portal.grantex.dev`, and `http://localhost:5173`; self-hosted deployments must set `CORS_ALLOWED_ORIGINS` to their exact production browser origins

---

## Deployment Options

### Docker Compose (development)

```bash
docker compose up -d
```

### Docker Compose (production)

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Google Cloud Run

```bash
# One-time setup
cd deploy/gcp
./setup.sh

# Deploy
gcloud run deploy grantex-auth \
  --source apps/auth-service \
  --region us-central1 \
  --set-env-vars "DATABASE_URL=...,REDIS_URL=...,JWT_ISSUER=..." \
  --set-secrets "RSA_PRIVATE_KEY=grantex-rsa-private-key:latest,ADMIN_API_KEY=grantex-admin-api-key:latest,VAULT_ENCRYPTION_KEY=grantex-vault-encryption-key:latest,METRICS_API_KEY=grantex-metrics-api-key:latest"
```

All four referenced secrets must already exist in Secret Manager and contain production values. Grant the Cloud Run runtime service account `roles/secretmanager.secretAccessor`. Never deploy production with `AUTO_GENERATE_KEYS=true`; an ephemeral key changes after a restart and invalidates signature verification. If metrics are explicitly disabled with `METRICS_ENABLED=false`, the metrics key is not required.

Or use the GitHub Actions deploy workflow (`.github/workflows/deploy.yml`).

### Kubernetes (Helm)

```bash
cd deploy/helm
helm install grantex ./grantex \
  --set-string externalDatabase.url="postgresql://..." \
  --set-string externalRedis.url="redis://..." \
  --set-string config.jwtIssuer="https://your-domain.com" \
  --set-file rsaPrivateKey=private.pem \
  --set-string adminApiKey="$(openssl rand -hex 32)" \
  --set-string vaultEncryptionKey="$(openssl rand -hex 32)" \
  --set-string metrics.apiKey="$(openssl rand -hex 32)"
```

For repeatable production installs, place these values in an encrypted values file or supply `existingSecret`; shell-generated values in an upgrade command would rotate credentials unexpectedly.

The Helm chart includes:
- Deployment with health checks
- HPA (Horizontal Pod Autoscaler)
- PDB (Pod Disruption Budget)
- Service Monitor (Prometheus)
- ConfigMap + Secret management
- Ingress configuration

### Nginx Reverse Proxy

```bash
cp deploy/nginx/nginx.conf /etc/nginx/sites-available/grantex
ln -s /etc/nginx/sites-available/grantex /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

The bundled `docker-compose.prod.yml` uses `TRUST_PROXY=1` because Nginx is the
only published HTTP service and the auth container is attached only to the
internal network. If you add an upstream CDN/load balancer, expose the auth
port directly, or create paths with different proxy counts, replace that value
with the verified chain configuration before deployment.

---

## SDKs

### TypeScript

```bash
npm install @grantex/sdk
```

### Python

```bash
pip install grantex
# Or from requirements.txt:
pip install -r requirements.txt
```

### Go

```bash
go get github.com/mishrasanjeev/grantex-go@latest
```

Resolve and test the current registry version, then commit the resulting lockfile or exact production pin. Do not copy old version numbers from this guide into a deployment manifest.

### SDK Configuration

All SDKs accept these options:

| Option | TS | Python | Go | Default |
|--------|-------|--------|------|---------|
| API Key | `apiKey` | `api_key` | first arg to `NewClient` | `GRANTEX_API_KEY` env |
| Base URL | `baseUrl` | `base_url` | `WithBaseURL()` | `https://api.grantex.dev` |
| Timeout | `timeout` | `timeout` | `WithTimeout()` | 30s |
| Max Retries | `maxRetries` | `max_retries` | `WithMaxRetries()` | 3 |

---

## Integration Packages

### Node.js / TypeScript

```bash
npm install @grantex/sdk                 # Core SDK
npm install @grantex/express             # Express.js middleware
npm install @grantex/gateway             # Zero-code reverse proxy
npm install @grantex/mcp                 # MCP server (17 tools)
npm install @grantex/mcp-auth            # OAuth 2.1 + PKCE for MCP
npm install @grantex/langchain           # LangChain integration
npm install @grantex/anthropic           # Anthropic SDK integration
npm install @grantex/vercel-ai           # Vercel AI SDK integration
npm install @grantex/autogen             # AutoGen integration
npm install @grantex/a2a                 # Google A2A bridge
npm install @grantex/destinations        # Event destinations (Datadog, Splunk, S3, BigQuery, Kafka)
npm install @grantex/conformance         # Conformance test suite
npm install @grantex/gemma              # Gemma offline auth
npm install @grantex/dpdp              # DPDP/EU AI Act compliance
npm install @grantex/mpp               # Machine Payments Protocol
npm install @grantex/x402              # x402 payment protocol
```

### Python

```bash
pip install grantex                      # Core SDK
pip install grantex-fastapi              # FastAPI middleware
pip install grantex-crewai               # CrewAI integration
pip install grantex-openai-agents        # OpenAI Agents SDK
pip install grantex-adk                  # Google ADK
pip install grantex-a2a                  # A2A Protocol Bridge
pip install grantex-gemma               # Gemma offline auth
```

### Go

```bash
go get github.com/mishrasanjeev/grantex-go@latest
```

### Terraform

```hcl
terraform {
  required_providers {
    grantex = {
      source = "mishrasanjeev/grantex"
    }
  }
}
```

### CLI

```bash
npm install -g @grantex/cli
grantex --help
```

---

## Monitoring

### Health Check

```bash
# Returns 200 when healthy, 503 when degraded
curl https://your-server/health
# {"status":"healthy","database":"ok","redis":"ok"}
```

Use this for:
- Load balancer health checks
- Kubernetes liveness/readiness probes
- Uptime monitoring (Pingdom, UptimeRobot, etc.)

### Prometheus Metrics

```bash
curl https://your-server/metrics
```

Exports: HTTP request duration, request counts, active connections, process metrics.

### Grafana

Import the pre-built dashboards from `deploy/grafana/`:
- `overview-dashboard.json` — system overview
- `per-agent-dashboard.json` — per-agent metrics

### OpenTelemetry

The auth service includes OpenTelemetry tracing. Configure the exporter:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-collector:4318"
export OTEL_SERVICE_NAME="grantex-auth-service"
```

### Structured Logging

All logs are structured JSON via pino:

```json
{"level":30,"time":1712345678,"msg":"token exchanged","reqId":"abc-123","developerId":"dev_1"}
```

Configure log level:
```bash
export LOG_LEVEL=info    # trace, debug, info, warn, error, fatal
```

In development, add `pino-pretty` for human-readable logs (installed as devDependency).

---

## Graceful Shutdown

The service handles SIGTERM and SIGINT:

1. Stops background workers (webhook delivery, anomaly detection)
2. Closes Redis connections
3. Drains database connection pool
4. Exits cleanly

This ensures zero-downtime deployments on Kubernetes, Cloud Run, or any container orchestrator.

---

## Scaling

### Horizontal Scaling

The auth service is stateless — scale by adding instances behind a load balancer. Redis and PostgreSQL are shared.

### Connection Limits

| Resource | Per Instance | 10 Instances |
|----------|-------------|--------------|
| PostgreSQL connections | 20 (pool max) | 200 |
| Redis connections | ~5 (client + pub/sub) | ~50 |

Ensure your PostgreSQL `max_connections` and Redis `maxclients` can handle your instance count.

### Rate Limiting

Standard-auth developer/plan counters use Redis and are shared across instances. Commerce, the SCIM Bearer data-plane (`/scim/v2/*`), admin, and other custom-auth routes are outside those plan counters and need an explicit quota policy; the standard-auth `/v1/scim/tokens` route does consume the developer plan budget. Fastify applies its process-local 5,000/min per-IP default to routes without an override, while a route-specific Fastify limit replaces that default for the route. The Redis plan budget is additional to the active Fastify per-IP policy. Every instance must use the same Redis deployment for plan budgets, and production ingress limits should stay above the 2,000/min Enterprise developer ceiling.

---

## Support

- **Docs:** https://docs.grantex.dev
- **GitHub:** https://github.com/mishrasanjeev/grantex
- **Discord:** https://discord.gg/QuSk7AeBdg
- **Security Hardening Guide:** https://docs.grantex.dev/guides/security-hardening
- **Operations Guide:** https://docs.grantex.dev/guides/operations
