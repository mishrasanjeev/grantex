/**
 * Docs snippet validation — verifies that code examples from anthropic.mdx
 * actually compile. This is a compile-only check (tsc --noEmit), not a runtime test.
 *
 * Each function represents a code snippet from the docs page.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Grantex } from '@grantex/sdk';
import {
  createGrantexTool,
  getGrantScopes,
  withAuditLogging,
  handleToolCall,
  GrantexToolRegistry,
  GrantexScopeError,
} from '../src/index.js';

// ─── Docs: "Scope-Enforced Tools" section ────────────────────────────────────

async function docsSnippet_scopeEnforcedTools() {
  const client = new Anthropic();
  const grantToken = 'placeholder';

  const readFileTool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
    grantToken,
    requiredScope: 'file:read',
    execute: async ({ path }) => {
      return `contents of ${path}`;
    },
  });

  // Pass definition to Claude
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [readFileTool.definition],
    messages: [{ role: 'user', content: 'Read config.json' }],
  });

  // Handle tool_use blocks
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const result = await readFileTool.execute(block.input as { path: string });
    }
  }
}

// ─── Docs: "Tool Registry" section ───────────────────────────────────────────

async function docsSnippet_toolRegistry() {
  const client = new Anthropic();
  const grantToken = 'placeholder';
  const messages: Anthropic.MessageParam[] = [];

  const readFileTool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    grantToken,
    requiredScope: 'file:read',
    execute: async (args) => String(args['path']),
  });

  const writeFileTool = createGrantexTool({
    name: 'write_file',
    description: 'Write a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    grantToken,
    requiredScope: 'file:write',
    execute: async (args) => ({ written: true }),
  });

  const registry = new GrantexToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);

  // Pass all definitions to Claude
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: registry.definitions,
    messages,
  });

  // Dispatch tool_use blocks
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const result = await registry.execute(block);
    }
  }
}

// ─── Docs: "Inspect Grant Scopes" section ────────────────────────────────────

function docsSnippet_inspectScopes() {
  const grantToken = 'placeholder';
  const scopes = getGrantScopes(grantToken);
  // scopes is string[]
  const _check: string[] = scopes;
}

// ─── Docs: "Audit Logging — Wrap a tool" section ────────────────────────────

async function docsSnippet_auditWrap() {
  const grantToken = 'placeholder';
  const grantex = new Grantex({ apiKey: 'test' });

  const readFileTool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    grantToken,
    requiredScope: 'file:read',
    execute: async (args) => String(args['path']),
  });

  const audited = withAuditLogging(readFileTool, grantex, {
    agentId: 'ag_01ABC',
    agentDid: 'did:key:z6Mk...',
    grantId: 'grnt_01XYZ',
    principalId: 'user_01',
  });

  // audited.execute() logs success/failure automatically
  const _result = await audited.execute({ path: '/test' });
}

// ─── Docs: "Handle a tool_use block directly" section ────────────────────────

async function docsSnippet_handleToolCall() {
  const client = new Anthropic();
  const grantex = new Grantex({ apiKey: 'test' });
  const grantToken = 'placeholder';

  const readFileTool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    grantToken,
    requiredScope: 'file:read',
    execute: async (args) => String(args['path']),
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [readFileTool.definition],
    messages: [{ role: 'user', content: 'test' }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const result = await handleToolCall(readFileTool, block, grantex, {
        agentId: 'ag_01ABC',
        agentDid: 'did:key:z6Mk...',
        grantId: 'grnt_01XYZ',
        principalId: 'user_01',
      });
    }
  }
}

// ─── Docs: GrantexScopeError catch pattern ───────────────────────────────────

async function docsSnippet_errorHandling() {
  const grantToken = 'placeholder';

  const tool = createGrantexTool({
    name: 'admin_tool',
    description: 'Admin action',
    inputSchema: { type: 'object' },
    grantToken,
    requiredScope: 'admin:all',
    execute: async () => 'ok',
  });

  try {
    await tool.execute({});
  } catch (err) {
    if (err instanceof GrantexScopeError) {
      // Both properties must be accessible
      const _required: string = err.requiredScope;
      const _granted: string[] = err.grantedScopes;
    }
  }
}
