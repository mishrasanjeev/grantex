# Commerce V1 Repeatable Option A Smoke Workflow

Status: C2A planning and tooling only. This workflow does not deploy, create cloud resources, merge, change production config, enable production Commerce V1, enable live payments, enable live Plural, read secret values, or write secret values.

## Purpose And Scope

This guide turns the successful one-off Option A smoke into a repeatable, approval-gated workflow with manual approval gates. Option A is the cheapest temporary hosted smoke path for Grantex Commerce V1. It proves the hosted Grantex API mock-provider commerce path over HTTPS while using isolated smoke resources that are deleted immediately after evidence capture.

Option A is not full hosted staging. It does not create custom DNS, Firebase portal staging, hosted AgenticOrg staging, production-like scaling, Plural sandbox, or live payment evidence.

## Cheapest Temporary Topology

| Component | Option A choice | Cost control |
| --- | --- | --- |
| Host project | Existing approved GCP project | Avoids new project setup |
| API runtime | Separate Cloud Run service `grantex-auth-smoke` | `min-instances=0`, `max-instances=1` |
| API URL | Direct approved Cloud Run `run.app` URL | No custom DNS |
| Database | Temporary tiny Cloud SQL Postgres `grantex-commerce-smoke-pg` | Delete after evidence |
| Redis | Temporary Basic 1GB Redis `grantex-commerce-smoke-redis` | Delete after evidence |
| Provider | `mock` only | No live payment provider |
| Portal | Local or skipped | No Firebase deploy |
| AgenticOrg | Local real-staging eval against approved smoke URL | No hosted AgenticOrg deploy |

## Manual Approval Gates

Stop for explicit human approval before each mutating phase:

1. Resource creation approval: project, region, SQL tier, Redis cost, cleanup deadline, and resource names.
2. Secret creation approval: smoke secret names only, with values supplied outside logs, files, PRs, and chat.
3. Smoke deploy approval: approved commit SHA and service name `grantex-auth-smoke`.
4. Smoke evidence approval: approved exact Cloud Run smoke URL and auth material names.
5. Cleanup approval is pre-approved as part of the spend window. Cleanup must run immediately after evidence.

The smoke plan script prints commands as `NOT RUN` only. Running those commands is a separate approved C2B action.

## Production Refusal Rules

Option A tooling must refuse:

- Cloud Run service name `grantex-auth`
- Cloud SQL instance `grantex-pg16`
- Redis instance `grantex-redis`
- Production URL `https://grantex.dev`
- Production API URL `https://api.grantex.dev`
- Production AgenticOrg URL `https://app.agenticorg.ai`
- Credentialed URLs
- Arbitrary `run.app` URLs unless the exact smoke URL is allowlisted
- `COMMERCE_LIVE_MODE_ENABLED=true`
- `PLURAL_LIVE_ENABLED=true`
- Non-mock providers

## Command Sequence

Generate the command plan:

```powershell
node scripts/commerce-option-a-smoke-plan.mjs --dry-run --project=grantex-prod --region=us-central1 --sql-tier=db-f1-micro --cleanup-by="2026-05-15T23:59:00+05:30"
```

Validate the seed manifest without writes:

```powershell
node scripts/commerce-option-a-smoke-seed.mjs --dry-run --manifest=docs/examples/commerce-staging-seed.manifest.json
```

Generate a local AgenticOrg fixture env file only after an exact approved smoke URL exists:

```powershell
node scripts/commerce-option-a-smoke-seed.mjs --dry-run --manifest=docs/examples/commerce-staging-seed.manifest.json --api-base=<approved-smoke-run-app-origin> --allow-smoke-cloud-run-url=<approved-smoke-run-app-origin> --write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env
```

The fixture export is disabled by default. The `--write-agenticorg-fixture-env` path must stay under `.tmp/`; committed docs and reports may name variables but must never contain usable auth material, passports, idempotency keys, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Validate the existing hosted smoke harness with an approved exact smoke URL:

```powershell
node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=<approved-smoke-run-app-origin> --allow-smoke-cloud-run-url=<approved-smoke-run-app-origin>
```

Generate the redacted evidence schema without requests:

```powershell
node scripts/commerce-option-a-smoke-evidence.mjs --dry-run --api-base=<approved-smoke-run-app-origin> --allow-smoke-cloud-run-url=<approved-smoke-run-app-origin>
```

## Cleanup Guarantees

Cleanup is part of the approved smoke window, not optional follow-up work. The command plan must include deletion commands for:

- Cloud Run service `grantex-auth-smoke`
- Redis instance `grantex-commerce-smoke-redis`
- Cloud SQL instance `grantex-commerce-smoke-pg`
- Smoke secret names matching `grantex-smoke-*`
- Smoke image tags if they are not referenced by any active service

The plan script refuses cleanup windows more than 24 hours in the future unless `--allow-long-cleanup-window` is explicitly passed.

## Cost Controls

- Keep Cloud Run `min-instances=0`.
- Keep Cloud Run `max-instances=1`.
- Use the approved cheapest SQL tier, such as `db-f1-micro` when available.
- Use temporary Basic Redis 1GB only because the current auth-service requires `REDIS_URL`.
- Do not configure custom DNS.
- Do not deploy Firebase portal.
- Do not deploy hosted AgenticOrg.
- Delete Cloud SQL and Redis immediately after evidence.

## Safety Controls

- Use smoke resources only.
- Use smoke secret names only.
- Do not read or print secret values.
- Do not write generated tokens, passports, idempotency keys, webhook secrets, provider credentials, raw payloads, or secret values to tracked files.
- Write any future generated harness env material only under `.tmp/` and keep it untracked.
- Write AgenticOrg real-staging fixture env files only under `.tmp/`, and keep cleanup/evidence warning language with every approved smoke handoff.
- Mock provider only.
- Keep mock provider only.
- Keep `COMMERCE_LIVE_MODE_ENABLED=false`.
- Keep `PLURAL_LIVE_ENABLED=false`.
- Keep `PLURAL_SANDBOX_ENABLED=false` unless a future approved sandbox contract changes that.

## AgenticOrg Local Real-Staging Eval Fit

After the Grantex smoke URL exists and the Grantex smoke flow passes, AgenticOrg can run locally against that same approved smoke URL. This does not require hosted AgenticOrg staging.

Required env names only:

```powershell
$env:GRANTEX_COMMERCE_BASE_URL='<approved-smoke-run-app-origin>'
$env:GRANTEX_BASE_URL='<approved-smoke-run-app-origin>'
$env:AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL='<approved-smoke-run-app-origin>'
$env:AGENTICORG_COMMERCE_REAL_STAGING='1'
# Set exactly one of GRANTEX_COMMERCE_BEARER_TOKEN, GRANTEX_AGENT_ASSERTION, or GRANTEX_API_KEY outside logs.
```

Optional local fixture bridge:

- Grantex writes `.tmp/commerce-agent-real-staging.env` only when `--write-agenticorg-fixture-env` is explicitly supplied.
- The file may contain the approved smoke URL, synthetic merchant/agent/product/variant IDs, exactly one auth source value if already present in the approved runtime environment, and optional usable synthetic passport fixture values.
- Usable passports, bearer tokens, agent assertions, API keys, idempotency keys, webhook secrets, and consent exchange material remain sensitive runtime material even when synthetic.
- Tool stdout may include variable names, counts, and redaction status only. It must not print values loaded from or written to the fixture env file.
- AgenticOrg consumes the file with `--fixture-env=.tmp/commerce-agent-real-staging.env` or `AGENTICORG_COMMERCE_FIXTURE_ENV=.tmp/commerce-agent-real-staging.env`.

Run plan after approval:

```powershell
python demos/commerce_sales_agent_demo.py --mode=real-staging --grantex-base '<approved-smoke-run-app-origin>' --allow-smoke-cloud-run-url '<approved-smoke-run-app-origin>' --evidence-report docs/reports/commerce-agent-real-staging-evidence.md
python demos/commerce_sales_agent_demo.py --mode=real-staging --fixture-env .tmp/commerce-agent-real-staging.env --evidence-report docs/reports/commerce-agent-real-staging-evidence.md
python -m pytest tests/evals/test_commerce_sales_agent_real_staging.py -q
```

AgenticOrg must continue to use only `grantex_commerce:*` aliases. It must not call Stripe, Plural, Pine, or provider credential paths for commerce.

## Automation Versus Manual Boundaries

Automated in C2A:

- Command generation as `NOT RUN`
- Manifest dry-run validation
- Smoke URL refusal validation
- Evidence schema generation without requests
- Validator assertions

Manual or later C2B:

- Creating GCP resources
- Adding secret versions
- Deploying `grantex-auth-smoke`
- Running migrations or seed writes
- Running hosted smoke requests
- Running AgenticOrg real-staging eval against an approved smoke URL
- Cleanup command execution
