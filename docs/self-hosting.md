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
| `JWT_VERIFICATION_PUBLIC_KEYS` | No | — | JWK Set (JSON) of public keys published for verification only: a key about to sign, or one that no longer signs; each key needs its thumbprint `kid` (as shown in the JWK Set) and `alg` |
| `JWT_LEGACY_KID_KEY` | No | the `RSA_PRIVATE_KEY` key | Thumbprint `kid` of the RSA key that signed tokens carrying a pre-0.6 `grantex-YYYY-MM` kid; set it when that key is no longer `RSA_PRIVATE_KEY` |
| `JWT_LEGACY_KID_MONTHS` | No | `13` | Months of `grantex-YYYY-MM` kid aliases published for the legacy key (current month and earlier); raise it if pre-0.6 grants live longer than a year; `0` publishes none |
| `SIGNING_KEY_STORE` | No | `env` | `env` (keys from the settings above) or `postgres` (stored encrypted; needs `VAULT_ENCRYPTION_KEY`) |
| `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` | No | `900` | How long a new key is published before it signs (postgres rotations, and the switch from the legacy kid after start); at least 90 |
| `SIGNING_KEY_RETIRED_GRACE_SECONDS` | No | `2592000` | How long a retired stored key stays in the JWK Set; must cover your longest grant lifetime |
| `MAX_GRANT_LIFETIME_SECONDS` | No | — | Longest grant `expiresIn` accepted by authorization and delegation; with the postgres store, start-up refuses a grace shorter than this |
| `SSO_STATE_SECRET` | No | derived | HMAC key for SSO state; derived from `RSA_PRIVATE_KEY`, `EC_PRIVATE_KEY` or `VAULT_ENCRYPTION_KEY` when unset, so every instance agrees |
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
| `MIGRATION_LOCK_TIMEOUT` | No | `2s` | How long a migration statement waits for a lock before the boot fails loudly (section 6) |
| `EVENT_BRIDGE_ENABLED` | No | `false` | Accept provider events (SSF/CAEP SETs, signed webhooks); see `docs/concepts/event-bridge-and-revocation.md` |
| `EVENT_BRIDGE_DEVELOPER_IDS` | No | — | Limit the event bridge to these developers (comma separated) |
| `EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE` | No | `30000` | Event ingestion requests per source and client address |

---

## 6. Database Migrations

Migrations run **automatically on every startup**, and each file is applied **once per database**.
The built-in runner (`src/db/migrate.ts`) reads all `*.sql` files from the `migrations/` directory in
alphabetical order, applies the ones this database has not seen, and records them in the
`schema_migrations` ledger (filename, checksum, applied-at). A start that has nothing to apply
touches no table at all.

That matters during a rolling deploy. Postgres takes an `ACCESS EXCLUSIVE` lock **before** it
evaluates `ADD COLUMN IF NOT EXISTS`, so a no-op `ALTER TABLE grants …` still queues behind
whatever transaction is touching `grants` — and every reader arriving after it waits behind that
queued request, including `/v1/authorize`, token exchange and delegation on the instance that is
still serving traffic. With the ledger a repeat start issues no DDL, so it cannot stall anything.

The first start after upgrading to a release with the ledger still applies every file once (that
is what fills the ledger) and is safe because every file is idempotent; plan it like any other
migration window. While applying, the runner sets `lock_timeout` (`MIGRATION_LOCK_TIMEOUT`,
default 2 s) and retries a few times, so a migration that cannot take its lock fails the boot
loudly instead of stalling the table. A file whose content changed after it was applied is
reported as a warning and never re-applied — ship a new migration instead.

The repository currently contains ordered migrations through `113`, covering core authorization, webhooks, policy, enterprise identity, credentials, budgets, offline operation, trust registry, DPDP, commerce, MCP certification-state integrity, query-performance indexes, agent prepaid wallets, and layered wallet spend controls. Index builds use `CREATE INDEX CONCURRENTLY`, and the runner serializes migrations across service instances with a PostgreSQL advisory lock. An index a cancelled concurrent build left `INVALID` is dropped before the file that creates it is retried, because `CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches such an index by name and would otherwise skip it forever. Inspect the migration directory in the exact release you deploy rather than relying on a copied file count.

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
`use: "sig"`. Verifiers select the key by `kid` and refuse a key whose type does not match the
token's algorithm. No step below invalidates an outstanding token: a key leaves the JWK Set only
after the tokens it signed have expired.

### Key ids

A key's `kid` is its RFC 7638 thumbprint, `grantex-rs256-…` or `grantex-es256-…`, so every
instance publishes the same `kid` for the same key whenever it started.

Before 0.6 the RS256 `kid` was `grantex-YYYY-MM` of the month the process started. Tokens carrying
such a kid keep verifying:

- the auth service verifies an RS256 token whose `kid` is `grantex-YYYY-MM`, or that has no
  `kid`, with the *legacy key* — `RSA_PRIVATE_KEY`, or the key named by `JWT_LEGACY_KID_KEY`;
- the JWK Set also publishes the legacy key under `grantex-YYYY-MM` for the current month and the
  previous `JWT_LEGACY_KID_MONTHS - 1` months, so SDK verifiers find it;
- for `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` after start, an instance still signs with the legacy
  kid, so resource servers holding a JWK Set fetched from a pre-0.6 instance keep accepting new
  tokens until they refresh it.

Upgrading needs no action. Do not remove the RSA key, and set `JWT_LEGACY_KID_KEY` if you replace
it, until pre-0.6 tokens have expired.

### Postgres key store

**Switching from the env store.** Set `SIGNING_KEY_STORE=postgres` and keep the existing key
settings for the first start. Every instance imports them: the env signing key becomes the stored
active key (same `kid`, so nothing changes for verifiers), and the other configured keys are stored
as retired public keys, keeping the legacy kid marker. Once the table holds them, the private key
settings can be removed.

**Rotation** is publish-then-sign:

```bash
node dist/cli/rotate-signing-key.js            # new key for JWT_SIGNING_ALG
node dist/cli/rotate-signing-key.js --alg ES256 # switch algorithm
```

The command stores a new pending key and prints when it activates. Every instance publishes it
within a minute. After `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` the next reload makes it the signing
key and retires the previous key, erasing its stored private key. The retired public key stays in
the JWK Set for `SIGNING_KEY_RETIRED_GRACE_SECONDS`, and the legacy kid key for the legacy alias
window. A second rotation is refused while one is pending. The stored active key is authoritative:
instances with a different `JWT_SIGNING_ALG` keep using it.

Set `MAX_GRANT_LIFETIME_SECONDS`; start-up refuses a grace window shorter than it, and without it a
warning says grants may outlive their key.

**Erasure limits.** Retiring a key sets its encrypted private key to `NULL`. The ciphertext can
remain in dead tuples until vacuum, in WAL and replicas, and in backups for their retention. It is
encrypted with `VAULT_ENCRYPTION_KEY` and bound to its `kid`, so it is useless without that key.
If a private key may have been exposed, rotate at once, and rotate `VAULT_ENCRYPTION_KEY` as part
of the response.

### Env key store

To replace a key (RSA to RSA, EC to EC, or a change of algorithm):

1. **Publish the new key.** Add its public JWK, with its thumbprint `kid` and `alg`, to
   `JWT_VERIFICATION_PUBLIC_KEYS` (for a change of algorithm you can instead set the other private
   key setting, for example `EC_PRIVATE_KEY` while `JWT_SIGNING_ALG=RS256`). Restart and wait at
   least `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` so verifiers see it.
2. **Sign with it.** Set the new private key (and `JWT_SIGNING_ALG` if it changes). Keep the old key
   verifiable: add the old public JWK to `JWT_VERIFICATION_PUBLIC_KEYS` (the entry for the new key
   may stay; the same key listed twice is one key). If the old key is an RSA key that signed
   pre-0.6 tokens, set `JWT_LEGACY_KID_KEY` to its thumbprint `kid`. Restart.
3. **Clean up** only after every token the old key signed has expired: remove its entry from
   `JWT_VERIFICATION_PUBLIC_KEYS`, and unset `JWT_LEGACY_KID_KEY` once pre-0.6 tokens have expired.

```bash
# Docker Compose
docker compose -f docker-compose.prod.yml up -d auth-service

# Kubernetes
kubectl rollout restart deployment/grantex -n grantex
```

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
