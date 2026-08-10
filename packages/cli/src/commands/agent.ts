import { Command, Option } from 'commander';
import chalk from 'chalk';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonMode } from '../format.js';

export const AGENT_SKILLS = ['use-grantex-cli', 'integrate-grantex'] as const;
export type AgentSkillTarget = 'openclaw' | 'hermes' | 'portable';

export interface AgentSkillInstallResult {
  target: AgentSkillTarget;
  root: string;
  installed: Array<{ name: string; path: string }>;
  nextStep: string;
}

function bundledSkillsRoot(): string {
  return fileURLToPath(new URL('../../agent-skills/', import.meta.url));
}

export function resolveAgentSkillRoot(
  target: AgentSkillTarget,
  cwd = process.cwd(),
  home = homedir(),
): string {
  switch (target) {
    case 'openclaw':
      return join(cwd, 'skills');
    case 'hermes':
      return join(home, '.hermes', 'skills', 'grantex');
    case 'portable':
      return join(cwd, '.agents', 'skills');
  }
}

function nextStepFor(target: AgentSkillTarget): string {
  switch (target) {
    case 'openclaw':
      return 'Run `openclaw skills check`, then start a new agent turn.';
    case 'hermes':
      return 'Run `hermes skills list`, then start a new Hermes session.';
    case 'portable':
      return 'Start a new agent session from this workspace.';
  }
}

export function installAgentSkills(options: {
  target: AgentSkillTarget;
  directory?: string;
  force?: boolean;
  cwd?: string;
  home?: string;
  sourceRoot?: string;
}): AgentSkillInstallResult {
  const cwd = options.cwd ?? process.cwd();
  const root = options.directory
    ? resolve(cwd, options.directory)
    : resolveAgentSkillRoot(options.target, cwd, options.home ?? homedir());
  const sourceRoot = options.sourceRoot ?? bundledSkillsRoot();
  const planned = AGENT_SKILLS.map((name) => ({
    name,
    source: join(sourceRoot, name),
    destination: join(root, name),
  }));

  for (const item of planned) {
    if (!existsSync(join(item.source, 'SKILL.md'))) {
      throw new Error(`Bundled skill is missing: ${item.name}`);
    }
  }

  const conflicts = planned.filter((item) => existsSync(item.destination));
  if (conflicts.length > 0 && !options.force) {
    throw new Error(
      `Skill already exists: ${conflicts.map((item) => item.destination).join(', ')}. ` +
      'Re-run with --force to update the bundled files.',
    );
  }

  mkdirSync(root, { recursive: true });
  for (const item of planned) {
    cpSync(item.source, item.destination, {
      recursive: true,
      force: options.force ?? false,
      errorOnExist: !(options.force ?? false),
    });
  }

  return {
    target: options.target,
    root,
    installed: planned.map((item) => ({ name: item.name, path: item.destination })),
    nextStep: nextStepFor(options.target),
  };
}

export function agentCommand(): Command {
  const cmd = new Command('agent')
    .description('Install Grantex skills for shell-capable AI agents');

  cmd
    .command('install')
    .description('Install portable Grantex Agent Skills')
    .addOption(
      new Option('--target <target>', 'Agent skill location')
        .choices(['openclaw', 'hermes', 'portable'])
        .default('portable'),
    )
    .option('--dir <directory>', 'Override the skill root directory')
    .option('--force', 'Update existing bundled skill files')
    .action((opts: { target: AgentSkillTarget; dir?: string; force?: boolean }) => {
      try {
        const result = installAgentSkills({
          target: opts.target,
          ...(opts.dir !== undefined ? { directory: opts.dir } : {}),
          ...(opts.force !== undefined ? { force: opts.force } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(
          chalk.green('\u2713') +
          ` Installed ${result.installed.length} Grantex skills in ${result.root}`,
        );
        for (const skill of result.installed) {
          console.log(`  ${chalk.dim('\u2502')} ${skill.name}`);
        }
        console.log('');
        console.log(`  Next: ${result.nextStep}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isJsonMode()) {
          console.log(JSON.stringify({ installed: false, error: message }));
        } else {
          console.error(chalk.red('\u2717') + ` ${message}`);
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
