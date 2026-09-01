# Docker Stress and Performance Report

- Date: 2026-09-01
- Environment: Windows 11 workstation, Docker Desktop 29.7.2, Node.js 24.15.0 load runner
- Target: one locally built Node.js 26 `apps/auth-service` container with PostgreSQL 16 and Redis 7
- Result: PASS after remediation

## Executive summary

The baseline uncovered one reproducible service defect: unmatched URLs were used as raw
Prometheus `route` labels. A caller sending unique paths could therefore create an
unbounded number of permanently retained histogram series. In the baseline, 1,200
unique paths created 1,200 new series, expanded the metrics response from 18,335 bytes
to 2,492,873 bytes, and increased container memory from 107.1 MiB to 155 MiB.

The metrics hook now maps every Fastify 404 to `__unmatched__`. The same 1,200-path
workload creates one series on a fresh process and zero additional series on a repeat
run. The first post-fix metrics response was 21,221 bytes, a 99.1% reduction from the
affected baseline response.

Two complete post-fix rounds executed 137,970 measured scenario requests. Both passed
all latency, throughput, error, rate-limit, body-size, recovery, and cardinality checks.
The full local Docker E2E suite then passed 255 tests across 23 files, including OAuth
DPoP, prepaid wallets, layered spend controls, event streaming, SSO, and MPP passports.

## Reproducible commands

The performance override pins the local issuer to the IPv4 loopback address. This
avoids Windows/WSL installations where `localhost` resolves to a competing `::1`
relay before Docker's published socket.

```powershell
docker compose `
  -f docker-compose.yml `
  -f docker-compose.performance.yml `
  -p grantex-stress `
  up -d --build

npm run test:stress:docker -- `
  --container=grantex-stress-auth-service-1 `
  --soak-seconds=30 `
  --report=.tmp/stress-final.json
```

The runner refuses non-local targets, applies a ten-second deadline to every request,
emits JSON evidence, and exits non-zero when a threshold or invariant fails.

## Workload

| Scenario | Requests | Concurrency | Expected behavior |
| --- | ---: | ---: | --- |
| Unmatched-route cardinality attack | 1,200 | 80 | `401`, bounded metric labels |
| Readiness dependency pressure | 1,500 | 50 | `200`, PostgreSQL and Redis healthy |
| Invalid API-key database pressure | 1,000 | 50 | `401`, no `5xx` or timeout |
| JWKS burst | 5,000 | 100 | `200`, at least 1,000 req/s |
| Authenticated DB and Redis path | 80 | 20 | `200`, below free-plan limit |
| Authenticated plan-limit burst | 80 | 20 | `200` then protective `429` |
| Oversized request bodies | 25 | 10 | `413` or early upload reset, no `5xx` |
| Sustained JWKS soak | 60,000 | 75 | `200`, at least 1,000 req/s |
| Post-pressure recovery | 100 | 10 | `200`, p95 below 150 ms |

Fastify can reset an oversized upload socket after detecting a `Content-Length` above
the 1 MiB body limit and before the client finishes transmitting. The harness accepts
either an HTTP `413` or that early transport reset for this one adversarial scenario.
It does not accept network errors in ordinary scenarios.

## Baseline finding

| Measure | Baseline |
| --- | ---: |
| Unmatched paths sent | 1,200 |
| HTTP histogram series before | 2 |
| HTTP histogram series after | 1,202 |
| Series delta | 1,200 |
| Metrics payload before | 18,335 bytes |
| Metrics payload after | 2,492,873 bytes |
| Container memory before | 107.1 MiB |
| Container memory after | 155 MiB |
| Unmatched-path throughput | 1,566.01 req/s |
| Unmatched-path p95 | 143.40 ms |

Root cause: `metricsHook.ts` used the raw request URL when Fastify selected its 404
handler. Prometheus treats each distinct route label as a separate histogram family,
including all bucket, sum, and count series.

## Remediation

`metricRouteLabel()` now checks Fastify's `request.is404` flag and returns the constant
`__unmatched__`. Registered routes continue to use Fastify's normalized route pattern,
such as `/v1/agents/:id`; the fallback for an unexpected missing route definition is
the constant `__unknown__` rather than caller-controlled input.

A unit regression test covers both unmatched and parameterized route labels. The
Docker stress runner supplies the integration proof against the real Prometheus
registry.

## Final results

First full post-fix round:

| Scenario | Throughput | p95 | Status |
| --- | ---: | ---: | --- |
| Unmatched-route cardinality | 1,939.02 req/s | 137.15 ms | PASS |
| Readiness dependency pressure | 1,804.97 req/s | 49.43 ms | PASS |
| Invalid API-key DB pressure | 2,214.33 req/s | 33.55 ms | PASS |
| JWKS burst | 1,760.17 req/s | 89.71 ms | PASS |
| Authenticated DB and Redis path | 929.79 req/s | 28.29 ms | PASS |
| Plan-limit burst | 1,256.43 req/s | 19.10 ms | PASS; 20 x `200`, 60 x `429` |
| Oversized-body protection | 157.13 req/s | 80.36 ms | PASS; no `5xx` |
| 60,000-request JWKS soak | 2,305.26 req/s | 55.15 ms | PASS |
| Post-pressure recovery | 1,981.02 req/s | 10.95 ms | PASS |

Cardinality after the fix:

| Measure | First final round | Repeat round |
| --- | ---: | ---: |
| Series before | 2 | 7 |
| Series after | 3 | 7 |
| Series delta | 1 | 0 |
| Metrics payload after | 21,221 bytes | 28,975 bytes |

The repeat soak sustained 1,559.62 req/s at 83.92 ms p95 and passed every threshold.
Container memory was 185.6 MiB before that repeat and 128.9 MiB afterward. Memory did
not grow monotonically across the second 68,985-request round, which is consistent with
normal V8 heap high-water and garbage-collection behavior rather than retained metric
series.

Across both final rounds there were no `5xx` responses, timeouts, or ordinary-scenario
network errors. The post-pressure readiness probe remained healthy.

## Functional verification after stress

The service was rebuilt on a fresh database and Redis volume after load testing.

| Verification | Result |
| --- | --- |
| Local Docker E2E files | 23/23 passed |
| Local Docker E2E tests | 255/255 passed |
| OAuth encrypted refresh replay after container restart | PASS |
| Auth-service unit test files | 167 passed, 1 skipped |
| Auth-service unit tests | 2,139 passed, 2 skipped |
| Auth-service typecheck | PASS |
| Auth-service production build | PASS |

## Scope and limits

This is a repeatable single-workstation, single-container stress assessment. It proves
bounded metrics behavior and local service resilience under the documented workload;
it is not a maximum-capacity claim for Cloud Run or a substitute for distributed load
testing against an isolated staging environment.

The run does not measure external Stripe, email, OPA, Cedar, LDAP, DNS, or third-party
webhook latency. It also does not test multi-instance Redis coordination, Cloud SQL
connection quotas, autoscaling, regional network latency, or production traffic. Those
belong in an authorized staging test with explicit cost, rate, and data-isolation
controls. The harness deliberately refuses production URLs.
