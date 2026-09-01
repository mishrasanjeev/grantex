# Docker Endurance Test - 2026-09-01

## Verdict

Functional endurance: **PASS**.

Strict all-scenario performance thresholds: **11/12 epochs passed**. All 12
five-minute sustained-soak scenarios passed. Epoch 6 narrowly missed only the
unmatched-route auxiliary thresholds: 498.19 requests/second against a 500
target and p95 308.73 ms against a 300 ms target. All 1,200 requests in that
scenario returned the expected 401 response, with no server or network errors.

The run executed on a local Windows workstation against an isolated Docker
Compose deployment. The load generator shared the auth-service container's
network namespace and could address only `http://127.0.0.1:3001`. This avoided
measuring Windows-to-Docker NAT and preserved the harness's non-local target
refusal.

## Scope

- Base commit: `34ef94ab0d78cfe074f6cdc3400ce7561b2b8d29`
- Tested working tree: base commit plus the fixes described below
- Sustained duration: 12 epochs x 300 seconds = 60 minutes
- Total wall time: 62.31 minutes
- Concurrency during each sustained phase: 75
- Total requests: 37,781,334
- Sustained-phase requests: 37,673,514
- Supporting checks per epoch: unmatched routes, readiness dependencies,
  invalid API keys, public JWKS distribution, authenticated PostgreSQL/Redis
  access, plan-rate limiting, oversized-body protection, cardinality, and
  post-pressure recovery

Raw artifacts are retained locally at:

`C:\tmp\grantex-endurance-one-hour-20260901-194002`

## Findings And Fixes

### Prometheus cardinality

The earlier stress pass fixed attacker-controlled unmatched paths appearing as
raw Prometheus `route` labels. This endurance run began with two HTTP histogram
series and ended with seven legitimate bounded route series. Eleven later
cardinality probes added zero series.

### Logger configuration

Startup called `buildApp({ logger: true })`, bypassing the configured
`LOG_LEVEL` and `LOG_PRETTY` options. Under load this emitted an info log for
every request. Startup now calls `buildApp()` and uses the central logger
configuration. A regression test verifies that `LOG_LEVEL=warn` is effective.

The endurance container produced no Pino warning/error/fatal records and did
not emit per-request info logs.

### JWKS dependency amplification

Every JWKS request previously exported platform keys, loaded commerce modules,
and queried PostgreSQL for commerce passport keys. A five-second single-flight
cache now deduplicates concurrent builds and bounds key-rotation visibility to
five seconds. The route advertises `Cache-Control: public, max-age=5,
must-revalidate`; sensitive routes retain the global `no-store` default.

Regression coverage verifies cached reuse, concurrent request deduplication,
expiry refresh, and the HTTP cache policy.

### Harness measurement correctness

The harness previously retained full result objects and repeatedly filtered
large arrays, allowing load-generator garbage collection to inflate the
post-pressure recovery measurement. It now aggregates statuses and errors as
requests complete and retains only numeric latency samples.

The previous `--soak-seconds` option estimated a fixed request count at 2,000
requests/second. Faster code therefore shortened the intended duration. It now
uses a monotonic deadline, and each reported five-minute phase runs for the
requested wall-clock duration.

`scripts/docker-endurance-test.ps1` provides repeatable multi-epoch execution,
Docker-network isolation, per-epoch CSV output, aggregate JSON output, and an
option to retain threshold misses without prematurely terminating an endurance
run.

## Results

| Epoch | Requests | Soak req/s | Soak p95 | Soak p99 | Recovery p95 | End memory | Gate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 1 | 2,025,131 | 6,720.11 | 22.59 ms | 35.01 ms | 10.13 ms | 76.71 MiB | PASS |
| 2 | 3,276,564 | 10,891.84 | 12.62 ms | 17.32 ms | 8.67 ms | 87.45 MiB | PASS |
| 3 | 4,544,486 | 15,117.95 | 7.62 ms | 10.31 ms | 8.90 ms | 114.90 MiB | PASS |
| 4 | 3,027,712 | 10,062.31 | 13.96 ms | 20.85 ms | 9.30 ms | 89.28 MiB | PASS |
| 5 | 2,012,033 | 6,674.93 | 34.22 ms | 48.79 ms | 25.57 ms | 88.69 MiB | PASS |
| 6 | 1,763,446 | 5,848.11 | 38.17 ms | 68.85 ms | 6.36 ms | 67.83 MiB | AUX MISS |
| 7 | 3,136,093 | 10,423.62 | 14.49 ms | 20.22 ms | 4.94 ms | 88.81 MiB | PASS |
| 8 | 3,321,860 | 11,042.59 | 13.18 ms | 18.80 ms | 7.76 ms | 116.20 MiB | PASS |
| 9 | 3,727,309 | 12,394.30 | 9.46 ms | 15.29 ms | 4.18 ms | 88.39 MiB | PASS |
| 10 | 3,840,461 | 12,771.44 | 9.96 ms | 15.89 ms | 6.34 ms | 88.49 MiB | PASS |
| 11 | 3,940,885 | 13,106.20 | 9.19 ms | 14.41 ms | 6.64 ms | 88.61 MiB | PASS |
| 12 | 3,165,354 | 10,521.13 | 23.13 ms | 38.81 ms | 6.05 ms | 116.10 MiB | PASS |

Aggregate sustained-phase results:

- Throughput: minimum 5,848.11; median 10,891.84; average 10,464.54;
  maximum 15,117.95 requests/second
- p95 latency: 17.38 ms average; 38.17 ms maximum
- p99 latency: 68.85 ms maximum
- Post-pressure recovery p95: 25.57 ms maximum
- Server errors: 0
- Disallowed network errors/timeouts: 0
- Container restarts: 0
- OOM kills: 0
- Auth-service process count: stable at 11
- End-of-epoch memory: 67.83-116.20 MiB

Memory was cyclical rather than monotonic. End memory moved from 76.71 MiB in
epoch 1 to 116.10 MiB in epoch 12, but returned to 67.83 MiB in epoch 6 and
approximately 88 MiB in epochs 9-11. This is a garbage-collection pattern, not
evidence of retained growth.

## Limitations

This is a strong single-instance local endurance result, not a production
capacity guarantee. The sustained workload intentionally concentrates on JWKS
distribution while other paths receive repeated burst checks. It does not
model internet latency, TLS termination, multiple Cloud Run replicas, regional
failover, production database sizing, wallet-issuer latency, or a production
traffic mix. Those require a separately approved staging load test with
observability and cost limits.
