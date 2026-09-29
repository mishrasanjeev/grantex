#!/usr/bin/env bash
set -eu
mkdir -p /audit /results
cp -a /source/. /audit/
if [ -d /work/packages/sdk-ts/node_modules ]; then
  cp -a /work/packages/sdk-ts/node_modules /audit/packages/sdk-ts/
fi
cd /audit/packages/sdk-ts
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test -- --reporter=json --outputFile=/results/sdk-ts.json
# The mock issuer resolves its optional local passport peer from the repo root.
cd /audit
npm ci --no-audit --no-fund
failed=0
for package in anthropic autogen vercel-ai langchain strands express a2a adapters gateway cli mcp-auth mcp x402 mpp gemma agent-passport agent-httpsig dpdp destinations conformance mock-issuer; do
  echo "VALIDATE $package"
  cd "/audit/packages/$package"
  if ! (npm ci --no-audit --no-fund &&
    npm run typecheck && npm run build --if-present && npm test -- --reporter=json --outputFile="/results/$package.json") >"/results/$package.log" 2>&1; then
    tail -80 "/results/$package.log"
    failed=1
  fi
done
cd /audit
if ! node scripts/verify-sdk-authority.mjs > /results/authority-boundaries.log 2>&1; then
  cat /results/authority-boundaries.log
  failed=1
fi
exit "$failed"
