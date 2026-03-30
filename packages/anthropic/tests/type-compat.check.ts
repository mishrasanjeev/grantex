/**
 * Type compatibility test — verifies our types work with the real Anthropic SDK.
 * This file is ONLY compiled (tsc --noEmit), never executed at runtime.
 * If it compiles, our types are compatible with the Anthropic SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  createGrantexTool,
  getGrantScopes,
  handleToolCall,
  GrantexToolRegistry,
  GrantexScopeError,
  type GrantexTool,
  type AnthropicToolUseBlock,
} from '../src/index.js';
import type { Grantex } from '@grantex/sdk';

// ─── Scenario 1: Pass tool.definition to client.messages.create ──────────────

function testToolDefinitionCompat() {
  const client = new Anthropic();

  const tool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    grantToken: 'fake.jwt.token',
    requiredScope: 'file:read',
    execute: async (args) => String(args['path']),
  });

  // This MUST compile — our definition must be assignable to the SDK's Tool type
  const _params: MessageCreateParamsNonStreaming = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [tool.definition],
    messages: [{ role: 'user', content: 'Read config.json' }],
  };
}

// ─── Scenario 2: Pass SDK ToolUseBlock to registry.execute ───────────────────

async function testToolUseBlockCompat() {
  const client = new Anthropic();
  const registry = new GrantexToolRegistry();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [],
    messages: [{ role: 'user', content: 'test' }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      // This MUST compile — SDK's ToolUseBlock must be assignable to our AnthropicToolUseBlock
      await registry.execute(block);
    }
  }
}

// ─── Scenario 3: Pass SDK ToolUseBlock to handleToolCall ─────────────────────

async function testHandleToolCallCompat() {
  const client = new Anthropic();
  const grantex = {} as Grantex;

  const tool = createGrantexTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    grantToken: 'fake.jwt.token',
    requiredScope: 'file:read',
    execute: async (args) => String(args['path']),
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [tool.definition],
    messages: [{ role: 'user', content: 'test' }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      // This MUST compile — SDK's ToolUseBlock to our handleToolCall
      await handleToolCall(tool, block, grantex, {
        agentId: 'ag_01',
        agentDid: 'did:key:z6Mk',
        grantId: 'grnt_01',
        principalId: 'user_01',
      });
    }
  }
}

// ─── Scenario 4: Registry definitions back to SDK ────────────────────────────

async function testRegistryDefinitionsCompat() {
  const client = new Anthropic();
  const registry = new GrantexToolRegistry();

  // Registry definitions MUST be assignable to the SDK's tools parameter
  const _params: MessageCreateParamsNonStreaming = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: registry.definitions,
    messages: [{ role: 'user', content: 'test' }],
  };
}
