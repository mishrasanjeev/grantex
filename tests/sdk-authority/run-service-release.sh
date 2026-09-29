#!/usr/bin/env bash
set -eu
mkdir -p /service /results
cp -a /source/. /service/
apt-get update -qq
apt-get install -y -qq python3-venv
python3 -m venv /service-python
/service-python/bin/python -m pip install /service/packages/sdk-py
export GRANTEX_E2E_PYTHON=/service-python/bin/python
cd /service/packages/sdk-ts
npm ci --no-audit --no-fund
npm run build
cd /service/apps/auth-service
npm ci --no-audit --no-fund
npm run typecheck
npm test -- --reporter=json --outputFile=/results/auth-release.json
npm run test:e2e
