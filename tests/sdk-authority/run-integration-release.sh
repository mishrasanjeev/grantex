#!/usr/bin/env bash
set -eu
mkdir -p /audit /results/npm /consumer
cp -a /source/. /audit/
cd /audit/packages/sdk-ts
npm ci --no-audit --no-fund
npm run build
for package in anthropic autogen vercel-ai langchain strands express a2a adapters gateway cli; do
  cd "/audit/packages/$package"
  npm ci --no-audit --no-fund
  npm run typecheck
  npm run build
  npm test -- --reporter=json --outputFile="/results/release-$package.json"
  npm pack --pack-destination /results/npm
done
npm install --prefix /consumer --ignore-scripts --no-audit --no-fund /results/npm/*.tgz @grantex/sdk@0.8.1
cd /audit
GRANTEX_AUTHORITY_CONSUMER_DIR=/consumer node scripts/verify-sdk-authority.mjs
node /consumer/node_modules/@grantex/cli/dist/index.js --version
