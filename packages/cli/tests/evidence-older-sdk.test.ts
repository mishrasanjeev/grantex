import { describe, expect, it, vi } from 'vitest';

// Simulate a published @grantex/sdk (0.6.x) that does not ship the evidence module.
vi.mock('@grantex/sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { evidence: _evidence, ...older } = actual;
  return older;
});

describe('CLI with an @grantex/sdk that has no evidence module', () => {
  it('still starts and registers every command, including evidence', async () => {
    const { createProgram } = await import('../src/index.js');
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('evidence');
    expect(names).toContain('grants');
  }, 60_000);

  it('reports the SDK requirement instead of crashing when evidence is used', async () => {
    const { loadEvidence, EXIT_USAGE } = await import('../src/commands/evidence.js');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(loadEvidence()).rejects.toThrow(`exit ${EXIT_USAGE}`);
    expect(errors.join('\n')).toContain('requires @grantex/sdk >= 0.7.0');
    vi.restoreAllMocks();
  });
});
