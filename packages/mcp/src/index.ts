#!/usr/bin/env node
import { Grantex } from '@grantex/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

const apiKey = process.env['GRANTEX_API_KEY'];
if (!apiKey) {
  console.error('Error: GRANTEX_API_KEY environment variable is required.');
  process.exit(1);
}

const grantex = new Grantex({
  apiKey,
  ...(process.env['GRANTEX_BASE_URL'] !== undefined
    ? { baseUrl: process.env['GRANTEX_BASE_URL'] }
    : {}),
});

const server = buildServer(grantex);
const transport = new StdioServerTransport();
await server.connect(transport);
