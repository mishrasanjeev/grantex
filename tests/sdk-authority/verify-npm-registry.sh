#!/usr/bin/env bash
set -eu
mkdir -p /registry-consumer
npm install --prefix /registry-consumer --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org @grantex/sdk@0.8.1 @grantex/mcp-auth@4.0.0
node /source/scripts/verify-mcp-consent-artifact.mjs /registry-consumer
