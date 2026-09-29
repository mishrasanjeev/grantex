#!/usr/bin/env bash
set -eu
mkdir -p /release/packages /results
cp -a /source/docs /source/spec /release/
cp -a /source/packages/sdk-ts /release/packages/
cp -a /source/packages/mcp-auth /release/packages/
cd /release/packages/sdk-ts
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm pack --pack-destination /results
cd /release/packages/mcp-auth
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test -- --reporter=json --outputFile=/results/mcp-auth-release-unit.json
npm run test:integration -- --reporter=json --outputFile=/results/mcp-auth-release-integration.json
npm run test:e2e -- --reporter=json --outputFile=/results/mcp-auth-release-browser.json
npm pack --pack-destination /results
mkdir -p /release/consumer
npm install --prefix /release/consumer --ignore-scripts --no-audit --no-fund /results/grantex-sdk-0.8.1.tgz /results/grantex-mcp-auth-4.0.0.tgz
node /source/scripts/verify-mcp-consent-artifact.mjs /release/consumer
