import { describe, it, expect, vi } from 'vitest';
import { withGrantexAuth as withGoogleADKAuth } from '../src/adapters/google-adk.js';
import { withGrantexAuth as withLangChainAuth } from '../src/adapters/langchain.js';
import { GrantexAuthError, ScopeViolationError } from '../src/errors.js';
import type { OfflineVerifier, VerifiedGrant } from '../src/verifier/offline-verifier.js';
import type { OfflineAuditLog, AuditEntry } from '../src/audit/offline-audit-log.js';
import type { SignedAuditEntry } from '../src/audit/hash-chain.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeGrant(overrides?: Partial<VerifiedGrant>): VerifiedGrant {
  return {
    agentDID: 'did:key:z6MkAgent',
    principalDID: 'user:alice',
    scopes: ['calendar:read', 'email:send'],
    expiresAt: new Date(Date.now() + 3600_000),
    jti: 'jti_001',
    grantId: 'grant_01',
    depth: 0,
    ...overrides,
  };
}

function makeVerifier(grant: VerifiedGrant): OfflineVerifier {
  return {
    verify: vi.fn().mockResolvedValue(grant),
  };
}

function makeFailingVerifier(error: Error): OfflineVerifier {
  return {
    verify: vi.fn().mockRejectedValue(error),
  };
}

function makeAuditLog(): OfflineAuditLog & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return {
    calls,
    append: vi.fn(async (entry: AuditEntry) => {
      calls.push(entry);
      return { ...entry, seq: calls.length, timestamp: new Date().toISOString(), prevHash: '0', hash: 'h', signature: 's' } as SignedAuditEntry;
    }),
    entries: vi.fn().mockResolvedValue([]),
    unsyncedCount: vi.fn().mockResolvedValue(0),
    markSynced: vi.fn().mockResolvedValue(undefined),
  };
}

/* ------------------------------------------------------------------ */
/*  Google ADK Adapter Tests                                           */
/* ------------------------------------------------------------------ */

describe('Google ADK adapter — withGrantexAuth', () => {
  it('wraps a tool with a "func" method', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'myTool', func: vi.fn().mockResolvedValue('result') };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token-jwt',
    });

    const result = await (wrapped.func as (...args: unknown[]) => Promise<unknown>)('arg1');
    expect(result).toBe('result');
    expect(verifier.verify).toHaveBeenCalledWith('token-jwt');
    expect(tool.func).toHaveBeenCalledWith('arg1');
    expect(auditLog.append).toHaveBeenCalledTimes(1);
    expect(auditLog.calls[0]!.result).toBe('success');
  });

  it('wraps a tool with a "run" method when "func" is absent', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'runTool', run: vi.fn().mockResolvedValue(42) };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token-jwt',
    });

    const result = await (wrapped.run as (...args: unknown[]) => Promise<unknown>)();
    expect(result).toBe(42);
    expect(tool.run).toHaveBeenCalled();
  });

  it('throws INVALID_TOOL when tool has neither "func" nor "run"', () => {
    const verifier = makeVerifier(makeGrant());
    const auditLog = makeAuditLog();

    expect(() =>
      withGoogleADKAuth({ name: 'bad' }, {
        verifier,
        auditLog,
        requiredScopes: [],
        grantToken: 'token',
      }),
    ).toThrow(GrantexAuthError);

    expect(() =>
      withGoogleADKAuth({ name: 'bad' }, {
        verifier,
        auditLog,
        requiredScopes: [],
        grantToken: 'token',
      }),
    ).toThrow('Tool must have a "func" or "run" method');
  });

  it('rejects and audits when token verification fails', async () => {
    const verifier = makeFailingVerifier(new Error('Invalid signature'));
    const auditLog = makeAuditLog();

    const tool = { name: 'myTool', func: vi.fn() };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'bad-token',
    });

    await expect(
      (wrapped.func as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(GrantexAuthError);

    expect(tool.func).not.toHaveBeenCalled();
    expect(auditLog.calls[0]!.result).toBe('auth_failure');
    expect(auditLog.calls[0]!.agentDID).toBe('');
  });

  it('rejects and audits when required scopes are missing', async () => {
    const grant = makeGrant({ scopes: ['calendar:read'] });
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'scopedTool', func: vi.fn() };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['admin:write'],
      grantToken: 'token',
    });

    await expect(
      (wrapped.func as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(ScopeViolationError);

    expect(tool.func).not.toHaveBeenCalled();
    expect(auditLog.calls[0]!.result).toBe('scope_violation');
  });

  it('audits execution errors', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'crashTool', func: vi.fn().mockRejectedValue(new Error('boom')) };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token',
    });

    await expect(
      (wrapped.func as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow('boom');

    expect(auditLog.calls[0]!.result).toBe('execution_error');
  });

  it('preserves all other tool properties', () => {
    const verifier = makeVerifier(makeGrant());
    const auditLog = makeAuditLog();

    const tool = {
      name: 'preservedTool',
      description: 'A test tool',
      schema: { type: 'object' },
      func: vi.fn(),
    };

    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: [],
      grantToken: 'token',
    });

    expect(wrapped.name).toBe('preservedTool');
    expect(wrapped.description).toBe('A test tool');
    expect(wrapped.schema).toEqual({ type: 'object' });
  });

  it('uses "unknown" as tool name in audit when name is absent', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { func: vi.fn().mockResolvedValue('ok') };
    const wrapped = withGoogleADKAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token',
    });

    await (wrapped.func as (...args: unknown[]) => Promise<unknown>)();
    expect(auditLog.calls[0]!.action).toBe('tool:unknown');
  });
});

/* ------------------------------------------------------------------ */
/*  LangChain Adapter Tests                                            */
/* ------------------------------------------------------------------ */

describe('LangChain adapter — withGrantexAuth', () => {
  it('wraps a tool with a "_call" method', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'lcTool', _call: vi.fn().mockResolvedValue('lc-result') };
    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['email:send'],
      grantToken: 'token-jwt',
    });

    const result = await (wrapped._call as (...args: unknown[]) => Promise<unknown>)('input');
    expect(result).toBe('lc-result');
    expect(verifier.verify).toHaveBeenCalledWith('token-jwt');
    expect(tool._call).toHaveBeenCalledWith('input');
    expect(auditLog.calls[0]!.result).toBe('success');
  });

  it('wraps a tool with "invoke" when "_call" is absent', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'invokeTool', invoke: vi.fn().mockResolvedValue('invoked') };
    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['email:send'],
      grantToken: 'token-jwt',
    });

    const result = await (wrapped.invoke as (...args: unknown[]) => Promise<unknown>)();
    expect(result).toBe('invoked');
    expect(tool.invoke).toHaveBeenCalled();
  });

  it('throws INVALID_TOOL when tool has neither "_call" nor "invoke"', () => {
    const verifier = makeVerifier(makeGrant());
    const auditLog = makeAuditLog();

    expect(() =>
      withLangChainAuth({ name: 'bad' }, {
        verifier,
        auditLog,
        requiredScopes: [],
        grantToken: 'token',
      }),
    ).toThrow(GrantexAuthError);

    expect(() =>
      withLangChainAuth({ name: 'bad' }, {
        verifier,
        auditLog,
        requiredScopes: [],
        grantToken: 'token',
      }),
    ).toThrow('Tool must have a "_call" or "invoke" method');
  });

  it('rejects and audits when token verification fails', async () => {
    const verifier = makeFailingVerifier(new Error('Expired'));
    const auditLog = makeAuditLog();

    const tool = { name: 'lcTool', _call: vi.fn() };
    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['email:send'],
      grantToken: 'expired-token',
    });

    await expect(
      (wrapped._call as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(GrantexAuthError);

    expect(tool._call).not.toHaveBeenCalled();
    expect(auditLog.calls[0]!.result).toBe('auth_failure');
  });

  it('rejects and audits scope violations', async () => {
    const grant = makeGrant({ scopes: ['email:send'] });
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'lcScopedTool', _call: vi.fn() };
    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['admin:write'],
      grantToken: 'token',
    });

    await expect(
      (wrapped._call as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(ScopeViolationError);

    expect(auditLog.calls[0]!.result).toBe('scope_violation');
  });

  it('audits execution errors from the underlying tool', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = { name: 'errTool', _call: vi.fn().mockRejectedValue(new Error('lc-fail')) };
    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token',
    });

    await expect(
      (wrapped._call as (...args: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow('lc-fail');

    expect(auditLog.calls[0]!.result).toBe('execution_error');
  });

  it('preserves all other tool properties', () => {
    const verifier = makeVerifier(makeGrant());
    const auditLog = makeAuditLog();

    const tool = {
      name: 'richTool',
      description: 'Has metadata',
      schema: { foo: 'bar' },
      returnDirect: true,
      _call: vi.fn(),
    };

    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: [],
      grantToken: 'token',
    });

    expect(wrapped.name).toBe('richTool');
    expect(wrapped.description).toBe('Has metadata');
    expect(wrapped.schema).toEqual({ foo: 'bar' });
    expect(wrapped.returnDirect).toBe(true);
  });

  it('passes multiple arguments through to the underlying function', async () => {
    const grant = makeGrant();
    const verifier = makeVerifier(grant);
    const auditLog = makeAuditLog();

    const tool = {
      name: 'multiArgTool',
      _call: vi.fn(async (a: unknown, b: unknown) => `${a}-${b}`),
    };

    const wrapped = withLangChainAuth(tool, {
      verifier,
      auditLog,
      requiredScopes: ['calendar:read'],
      grantToken: 'token',
    });

    const result = await (wrapped._call as (...args: unknown[]) => Promise<unknown>)('hello', 'world');
    expect(result).toBe('hello-world');
    expect(tool._call).toHaveBeenCalledWith('hello', 'world');
  });
});
