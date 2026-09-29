#!/usr/bin/env bash
set -eu
mkdir -p /registry-consumer
npm install --prefix /registry-consumer --ignore-scripts --no-audit --no-fund \
  @grantex/sdk@0.8.1 @grantex/anthropic@0.1.2 @grantex/autogen@0.1.7 \
  @grantex/vercel-ai@0.1.7 @grantex/langchain@0.1.8 @grantex/strands@0.2.1 \
  @grantex/express@0.1.6 @grantex/a2a@0.1.4 @grantex/adapters@0.2.1 \
  @grantex/gateway@0.2.1 @grantex/cli@0.4.1
GRANTEX_AUTHORITY_CONSUMER_DIR=/registry-consumer node /source/scripts/verify-sdk-authority.mjs
node /registry-consumer/node_modules/@grantex/cli/dist/index.js --version
