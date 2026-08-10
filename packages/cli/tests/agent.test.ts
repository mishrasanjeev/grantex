import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_SKILLS,
  agentCommand,
  installAgentSkills,
  resolveAgentSkillRoot,
} from '../src/commands/agent.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grantex-agent-skills-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('agentCommand()', () => {
  it('registers the install subcommand', () => {
    const cmd = agentCommand();
    expect(cmd.name()).toBe('agent');
    expect(cmd.commands.map((subcommand) => subcommand.name())).toContain('install');
  });
});

describe('resolveAgentSkillRoot()', () => {
  it('uses the OpenClaw workspace skills directory', () => {
    expect(resolveAgentSkillRoot('openclaw', 'C:\\workspace', 'C:\\home'))
      .toBe(join('C:\\workspace', 'skills'));
  });

  it('uses the Hermes personal skill category', () => {
    expect(resolveAgentSkillRoot('hermes', 'C:\\workspace', 'C:\\home'))
      .toBe(join('C:\\home', '.hermes', 'skills', 'grantex'));
  });

  it('uses the portable project Agent Skills directory', () => {
    expect(resolveAgentSkillRoot('portable', 'C:\\workspace', 'C:\\home'))
      .toBe(join('C:\\workspace', '.agents', 'skills'));
  });
});

describe('installAgentSkills()', () => {
  it('bundles the canonical repository skill content', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    for (const name of AGENT_SKILLS) {
      for (const relativePath of ['SKILL.md', join('agents', 'openai.yaml')]) {
        const bundled = readFileSync(
          join(testDir, '..', 'agent-skills', name, relativePath),
          'utf8',
        );
        const canonical = readFileSync(
          join(testDir, '..', '..', '..', 'skills', name, relativePath),
          'utf8',
        );
        expect(bundled.replace(/\r\n/g, '\n')).toBe(canonical.replace(/\r\n/g, '\n'));
      }
    }
  });

  it('installs both bundled skills into a portable project root', () => {
    const cwd = makeTempDir();
    const result = installAgentSkills({ target: 'portable', cwd, home: cwd });

    expect(result.installed.map((skill) => skill.name)).toEqual([...AGENT_SKILLS]);
    for (const skill of result.installed) {
      expect(existsSync(join(skill.path, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(skill.path, 'agents', 'openai.yaml'))).toBe(true);
    }
  });

  it('honors a custom relative directory', () => {
    const cwd = makeTempDir();
    const result = installAgentSkills({
      target: 'portable',
      directory: 'custom-skills',
      cwd,
      home: cwd,
    });

    expect(result.root).toBe(join(cwd, 'custom-skills'));
  });

  it('refuses to overwrite an existing skill without force', () => {
    const cwd = makeTempDir();
    installAgentSkills({ target: 'portable', cwd, home: cwd });

    expect(() => installAgentSkills({ target: 'portable', cwd, home: cwd }))
      .toThrow('Skill already exists');
  });

  it('updates bundled files with force without deleting unrelated files', () => {
    const cwd = makeTempDir();
    const first = installAgentSkills({ target: 'portable', cwd, home: cwd });
    const skillDir = first.installed[0]!.path;
    writeFileSync(join(skillDir, 'SKILL.md'), 'stale');
    writeFileSync(join(skillDir, 'notes.txt'), 'keep');

    installAgentSkills({ target: 'portable', cwd, home: cwd, force: true });

    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('name: use-grantex-cli');
    expect(readFileSync(join(skillDir, 'notes.txt'), 'utf8')).toBe('keep');
  });
});
