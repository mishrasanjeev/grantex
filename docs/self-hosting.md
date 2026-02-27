# Self-Hosting Grantex

This guide covers running your own Grantex auth service — from a quick local spin-up to a
production-grade Kubernetes deployment.

---

## 1. Quick Start (Dev)

The fastest way to run the full stack locally:

```bash
git clone https://github.com/mishrasanjeev/grantex.git
cd grantex
docker compose up --build
```

This starts PostgreSQL, Redis, and the auth service. Two developer accounts are seeded
automatically:

| Account | API key | Mode |
|---|---|---|
| Live | `dev-api-key-local` | Normal consent flow |
| Sandbox | `sandbox-api-key-local` | Auto-approves grants, returns `code` immediately |

Verify it's running:

```bash
curl http://localhost:3001/health
# { "status": "ok" }

curl http://localhost:3001/.well-known/jwks.json
# { "keys": [{ "kty": "RSA", "alg": "RS256", ... }] }
```

> **Note:** The dev compose exposes database and Redis ports and uses hardcoded credentials.
> Never use it in production.

---

## 2. Generating a Production RSA Key

Grantex signs grant tokens with RSA-256. Generate a 2048-bit private key once and store it
securely:

```bash
openssl genrsa -out private.pem 2048
```

For use in environment variables or Kubernetes secrets, collapse it to a single line with
literal `\n` between each PEM line:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' private.pem
```

Copy the output (starting with `-----BEGIN RSA PRIVATE KEY-----\n...`) and use it as
`RSA_PRIVATE_KEY`.

> Keep `private.pem` out of source control. The JWKS endpoint (`GET /.well-known/jwks.json`)
> exposes only the public key, so tokens remain verifiable after key rotation.

---

## 3. Production Docker Compose

### Prerequisites

- Docker 24+ with Compose v2
- A domain name with DNS pointing to your server
- TLS certificate (self-signed for testing; Let's Encrypt for production)

### Step 1 — Copy and fill in the env file

```bash
cp .env.prod.example .env.prod
```

Edit `.env.prod` and replace every `change-me-*` placeholder with strong randomly generated
values. Set `RSA_PRIVATE_KEY` to the collapsed PEM from Section 2, and `JWT_ISSUER` to your
public base URL (e.g. `https://auth.example.com`).

### Step 2 — Provide TLS certificates

Place your certificate and private key at:

```
deploy/nginx/certs/server.crt
deploy/nginx/certs/server.key
```

**Self-signed (testing only):**

```bash
mkdir -p deploy/nginx/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout deploy/nginx/certs/server.key \
  -out deploy/nginx/certs/server.crt \
  -subj "/CN=localhost"
```

**Let's Encrypt (production):**

```bash
certbot certonly --standalone -d auth.example.com
cp /etc/letsencrypt/live/auth.example.com/fullchain.pem deploy/nginx/certs/server.crt
cp /etc/letsencrypt/live/auth.example.com/privkey.pem   deploy/nginx/certs/server.key
```

### Step 3 — Start the stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Verify:

```bash
curl https://your-domain.example.com/health
# { "status": "ok" }
```

### Architecture

```
Internet → nginx (:443) → auth-service:3001
                ↓
           postgres + redis  (internal network only, ports not exposed)
```

---

## 4. Kubernetes / Helm

### Prerequisites

- Kubernetes 1.26+
- Helm 3.x
- A managed PostgreSQL instance (RDS, Cloud SQL, Neon, etc.)
- A managed Redis instance (ElastiCache, Upstash, etc.)
- An RSA private key (see Section 2)

### Install

```bash
helm install grantex deploy/helm/grantex/ \
  --namespace grantex --create-namespace \
  --set externalDatabase.url="postgres://user:pass@host:5432/grantex" \
  --set externalRedis.url="redis://:pass@host:6379" \
  --set rsaPrivateKey="$(awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' private.pem)" \
  --set config.jwtIssuer="https://auth.example.com"
```

### Enable Ingress

```bash
helm upgrade grantex deploy/helm/grantex/ \
  --reuse-values \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.hosts[0].host=auth.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  --set "ingress.tls[0].secretName=grantex-tls" \
  --set "ingress.tls[0].hosts[0]=auth.example.com"
```

### Use an existing Secret

If you manage secrets externally (Vault, Sealed Secrets, External Secrets Operator):

```bash
kubectl create secret generic grantex-secrets \
  --namespace grantex \
  --from-literal=RSA_PRIVATE_KEY="$(cat private.pem)"

helm install grantex deploy/helm/grantex/ \
  --namespace grantex \
  --set existingSecret=grantex-secrets \
  --set externalDatabase.url="..." \
  --set externalRedis.url="..."
```

### Upgrading

```bash
docker build -t grantex/auth-service:0.2.0 ./apps/auth-service
docker push grantex/auth-service:0.2.0

helm upgrade grantex deploy/helm/grantex/ \
  --reuse-values \
  --set image.tag=0.2.0
```

### Rollback

```bash
helm rollback grantex 1   # roll back to revision 1
```

---

## 5. Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string (include password if set) |
| `RSA_PRIVATE_KEY` | Yes* | — | PEM private key for JWT signing. *Or set `AUTO_GENERATE_KEYS=true` (dev only) |
| `AUTO_GENERATE_KEYS` | No | `false` | Auto-generate RSA keypair at startup (dev only — invalidated on restart) |
| `JWT_ISSUER` | Yes | `https://grantex.dev` | `iss` claim in every JWT; your public base URL |
| `PORT` | No | `3001` | Port the auth service listens on |
| `HOST` | No | `0.0.0.0` | Bind address |
| `SEED_API_KEY` | No | — | Pre-seed a live developer API key (dev only — omit in prod) |
| `SEED_SANDBOX_KEY` | No | — | Pre-seed a sandbox API key (dev only — omit in prod) |
| `STRIPE_SECRET_KEY` | No | — | Enable Stripe billing integration |
| `STRIPE_WEBHOOK_SECRET` | No | — | Stripe webhook signature validation |
| `STRIPE_PRICE_PRO` | No | — | Stripe price ID for Pro tier |
| `STRIPE_PRICE_ENTERPRISE` | No | — | Stripe price ID for Enterprise tier |

---

## 6. Database Migrations

Migrations run automatically via PostgreSQL's `docker-entrypoint-initdb.d/` mechanism — SQL
files are only executed on a **fresh database volume**. On subsequent starts the named volume
already exists, so init scripts are skipped.

**Upgrade procedure** (existing install):

```bash
# Pull the new image
docker compose -f docker-compose.prod.yml pull auth-service

# Restart the service
docker compose -f docker-compose.prod.yml up -d auth-service
```

Apply new migration files manually to an existing database:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d grantex \
  -f /docker-entrypoint-initdb.d/006_policies.sql
```

Migration files are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

---

## 7. Key Rotation

1. Generate a new RSA key pair (Section 2).
2. Update `RSA_PRIVATE_KEY` in your env file or Kubernetes secret.
3. Restart the auth service:

```bash
# Docker Compose
docker compose -f docker-compose.prod.yml up -d auth-service

# Kubernetes
kubectl rollout restart deployment/grantex -n grantex
```

Tokens signed with the old key remain valid until expiry because the JWKS endpoint
(`GET /.well-known/jwks.json`) always exposes the current public key — clients re-fetch it
automatically when verification fails. If you need to immediately invalidate old tokens,
revoke them individually via `POST /v1/tokens/revoke`.

---

## 8. Health Checks & Monitoring

### Health endpoint

```
GET /health
→ 200 { "status": "ok" }
```

Returns `200` when the service is up and connected. The Docker Compose healthcheck and
Kubernetes liveness/readiness probes both use this endpoint.

### Structured logging

All logs are emitted as JSON to stdout, compatible with Datadog, Loki, and CloudWatch Logs.
No configuration needed — just forward stdout from your container runtime.

### Prometheus metrics

The auth service does not yet expose a `/metrics` endpoint. In the interim, use your ingress
controller or a sidecar proxy to scrape HTTP request metrics. Native Prometheus support is
tracked for a future release.

---

## 9. Backup & Recovery

### PostgreSQL

Back up with `pg_dump`:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" grantex | gzip > "grantex-$(date +%Y%m%d).sql.gz"
```

Restore:

```bash
gunzip < grantex-20260101.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" grantex
```

Schedule daily backups with cron or your cloud provider's managed snapshot feature.

### Redis

Redis holds ephemeral token metadata and rate-limiting state — not primary data. For
durability enable AOF persistence:

```
appendonly yes
appendfsync everysec
```

If Redis data is lost, in-flight auth requests will fail temporarily, but no permanent data
is lost. PostgreSQL is the source of truth for all grants, audit entries, and agent records.

---

## 10. Production Readiness Checklist

Before going live, verify each item:

- [ ] `RSA_PRIVATE_KEY` is a real 2048-bit (minimum) RSA key — **not** `AUTO_GENERATE_KEYS=true`
- [ ] `POSTGRES_PASSWORD` and `REDIS_PASSWORD` are strong, randomly generated values (e.g. `openssl rand -hex 32`)
- [ ] `SEED_API_KEY` and `SEED_SANDBOX_KEY` are **not** set in production
- [ ] TLS is enabled end-to-end — nginx terminates HTTPS; internal services are on a private network with no exposed ports
- [ ] Database and Redis ports are **not** exposed to the public internet
- [ ] `JWT_ISSUER` matches your public base URL exactly — clients validate this claim during token verification
- [ ] Automated database backups are scheduled and have been tested with a restore
- [ ] Health checks are wired into your load balancer or uptime monitor
- [ ] CPU and memory limits are set to prevent runaway containers
- [ ] Log forwarding is configured (stdout → your observability stack)
