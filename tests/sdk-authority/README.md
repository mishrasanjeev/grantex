# SDK Authority Regression Suite

These suites validate the local source candidates, not registry releases.
They run all 34 package suites plus signed-token/HTTP authority boundary
regressions. The dedicated workflow is `.github/workflows/sdk-authority.yml`.

Use disposable services only. From a Linux shell at the repository root:

```bash
docker network create sdk-authority
docker run -d --name authority-pg --network sdk-authority \
  -e POSTGRES_PASSWORD=synthetic-audit-only -e POSTGRES_DB=sdk_authority postgres:16-alpine
docker run -d --name authority-redis --network sdk-authority redis:7-alpine
until docker exec authority-pg pg_isready -U postgres; do sleep 1; done
mkdir -p results
```

Run each image/script pair below with the same command. The images need
outbound package-registry access; no real issuer or model credentials are used.

| Image | Script |
| --- | --- |
| `node:24.20.0-bookworm-slim` | `run-node.sh` |
| `python:3.12-slim` | `run-python.sh` |
| `golang:1.26.1` | `run-go.sh` |

```bash
IMAGE=node:24.20.0-bookworm-slim
SCRIPT=run-node.sh
docker run --rm --network sdk-authority \
  --mount "type=bind,source=$PWD,target=/source,readonly" \
  --mount "type=bind,source=$PWD/results,target=/results" \
  -e GRANTEX_CAPS_REDIS_URL=redis://authority-redis:6379/0 \
  -e GRANTEX_CAPS_POSTGRES_URL=postgres://postgres:synthetic-audit-only@authority-pg:5432/sdk_authority \
  -e GRANTEX_CAPS_REQUIRE_INTEGRATION=1 \
  --entrypoint bash "$IMAGE" "/source/tests/sdk-authority/$SCRIPT"
```

The scripts copy source to the container's disposable filesystem, install
locked Node dependencies or Python/Go development dependencies, typecheck/build,
and retain JSON/JUnit/Go JSONL results. Failures return a non-zero exit code.
Two existing MCP storage-contract inspection tests are skipped where their
adapter lacks a raw-dump test interface; do not count them as passed.

After all scripts finish:

```bash
docker rm -f authority-pg authority-redis
docker network rm sdk-authority
```

Node boundary cases use genuine framework libraries and local signed JWKS/
issuer HTTP fixtures. Some optional Python framework objects use test doubles.
Neither suite performs production account changes, real wallet payments, or
physical authenticator enrollment. Hosts must configure the optional authority
profile; this suite does not change historical offline defaults.
