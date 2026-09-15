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

## 2. Generating a Production Signing Key

Grantex signs grant tokens with RS256 by default, or with ES256 when `JWT_SIGNING_ALG=ES256`.
Generate the private key once, in PKCS#8 form, and store it securely:

```bash
# RS256 (default): RSA_PRIVATE_KEY
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem

# ES256: EC_PRIVATE_KEY
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out private-ec.pem
```

For use in environment variables or Kubernetes secrets, collapse it to a single line with
literal `\n` between each PEM line:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' private.pem
```

Copy the output (starting with `-----BEGIN PRIVATE KEY-----\n...`) and use it as
`RSA_PRIVATE_KEY` (or `EC_PRIVATE_KEY` for the EC key).

Instead of supplying keys, `SIGNING_KEY_STORE=postgres` lets the service generate the key on
first start and store it in `platform_signing_keys`, encrypted with `VAULT_ENCRYPTION_KEY`
(see Section 7).

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

This table is a quick-start subset, not an exhaustive schema. Consult `apps/auth-service/src/config.ts` and `.env.example` from the exact release you deploy for all feature-specific settings and validation rules.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string (include password if set) |
| `JWT_SIGNING_ALG` | No | `RS256` | Signing algorithm: `RS256` or `ES256` |
| `RSA_PRIVATE_KEY` | Yes* | — | PKCS#8 PEM RSA private key (RS256). *Required for `JWT_SIGNING_ALG=RS256` with the env key store, unless `AUTO_GENERATE_KEYS=true` (dev only). When `JWT_SIGNING_ALG=ES256`, a configured RSA key is published for verification only |
| `EC_PRIVATE_KEY` | Yes* | — | PKCS#8 PEM EC P-256 private key (ES256). *Required for `JWT_SIGNING_ALG=ES256` with the env key store. When `JWT_SIGNING_ALG=RS256`, a configured EC key is published for verification only |
| `JWT_SIGNING_KID` | No | — | `kid` of the env-store signing key (default: `grantex-YYYY-MM` for RS256, `grantex-es256-<thumbprint>` for ES256) |
| `JWT_RETIRED_PUBLIC_KEYS` | No | — | JWK Set (JSON) of public keys that no longer sign but must still verify; each key needs `kid` and `alg` |
| `SIGNING_KEY_STORE` | No | `env` | `env` (keys from the settings above) or `postgres` (generated and stored encrypted; needs `VAULT_ENCRYPTION_KEY`) |
| `SIGNING_KEY_RETIRED_GRACE_SECONDS` | No | `2592000` | How long a retired stored key stays in the JWK Set; longer than your longest token lifetime |
| `AUTO_GENERATE_KEYS` | No | `false` | Auto-generate the signing key at startup (dev only — invalidated on restart) |
| `GRANT_TOKEN_LEGACY_CLAIMS` | No | `true` | Issue the pre-0.6 claim aliases (`agt`, `dev`, `grnt`, `scp`, `parentAgt`, `parentGrnt`, `delegationDepth`, `bdg`) next to the standard claims. Defaults to `false` in 0.7; see `docs/migration-0.6.md` |
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

Migrations run **automatically on every startup**. The auth service includes a built-in migration
runner (`src/db/migrate.ts`) that reads all `*.sql` files from the `migrations/` directory in
alphabetical order and executes each one. All statements use idempotent DDL (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so re-running is safe.

The repository currently contains ordered migrations through `092`, covering core authorization, webhooks, policy, enterprise identity, credentials, budgets, offline operation, trust registry, DPDP, commerce, MCP certification-state integrity, query-performance indexes, agent prepaid wallets, and layered wallet spend controls. Index builds use `CREATE INDEX CONCURRENTLY`, and the runner serializes migrations across service instances with a PostgreSQL advisory lock. Inspect the migration directory in the exact release you deploy rather than relying on a copied file count.

**Upgrade procedure** — just restart the service:

```bash
# Docker Compose
docker compose -f docker-compose.prod.yml pull auth-service
docker compose -f docker-compose.prod.yml up -d auth-service

# Kubernetes
kubectl rollout restart deployment/grantex -n grantex
```

New migration files are applied automatically on startup. No manual SQL execution required.

---

## 7. Key Rotation

`GET /.well-known/jwks.json` publishes every platform signing key with `kid`, `alg` and
`use: "sig"`: the active key first, then keys kept for verification. Verifiers select the key by
`kid` and refuse a key whose type does not match the token's algorithm.

### Postgres key store

With `SIGNING_KEY_STORE=postgres`, rotate with the bundled command:

```bash
node dist/cli/rotate-signing-key.js            # new key for JWT_SIGNING_ALG
node dist/cli/rotate-signing-key.js --alg ES256 # switch algorithm
```

The command retires the active key, erases its private key, and stores a new active key. Running
instances start signing with it within a minute. The retired public key stays in the JWK Set for
`SIGNING_KEY_RETIRED_GRACE_SECONDS`, so tokens it signed keep verifying. The stored active key is
authoritative: instances with a different `JWT_SIGNING_ALG` keep using it rather than rotating.

### Env key store

1. Publish the new key before it signs: add the new private key under the other setting (for
   example `EC_PRIVATE_KEY` while `JWT_SIGNING_ALG=RS256`) and restart. It appears in the JWK Set
   for verification only. Wait for verifier JWKS caches to refresh.
2. Switch `JWT_SIGNING_ALG` (or replace the key) and restart. New tokens use the new key; the
   old key, still configured, keeps verifying.
3. Once you want the old private key gone, copy its public JWK (with `kid` and `alg`) from the
   JWK Set into `JWT_RETIRED_PUBLIC_KEYS`, remove the private key setting and restart.
4. Remove it from `JWT_RETIRED_PUBLIC_KEYS` after the tokens it signed have expired.

```bash
# Docker Compose
docker compose -f docker-compose.prod.yml up -d auth-service

# Kubernetes
kubectl rollout restart deployment/grantex -n grantex
```

The RS256 key's default `kid` is `grantex-YYYY-MM` of the start month; set `JWT_SIGNING_KID` so the
`kid` does not change when an instance restarts in a new month.

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

When `METRICS_ENABLED=true` (the default), the auth service exposes Prometheus text at
`GET /metrics`. The endpoint is unauthenticated and limited to 10 requests per minute per IP;
restrict it at your network boundary if metrics must remain private.

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

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
