import { Command } from 'commander';
import chalk from 'chalk';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isJsonMode } from '../format.js';

const PACKAGE_JSON = `{
  "name": "my-gemma-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "npx tsx index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@grantex/gemma": "^0.1.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
`;

const INDEX_TS = `import {
  createConsentBundle,
  issueGrantToken,
  verifyGrantToken,
  logAuditEntry,
  createAuditChain,
  verifyAuditChain,
  generateKeyPair,
} from '@grantex/gemma';

async function main() {
  // 1. Generate a signing key pair (Ed25519)
  const keyPair = await generateKeyPair();
  console.log('Generated key pair for offline signing');

  // 2. Create a consent bundle — defines what the agent is allowed to do
  const bundle = createConsentBundle({
    principalId: 'user_alice',
    agentId: 'gemma-assistant',
    scopes: ['calendar:read', 'email:send:max_10'],
    expiresIn: '24h',
  });
  console.log('Consent bundle created:', bundle.bundleId);

  // 3. Issue a grant token (offline JWT)
  const { token } = await issueGrantToken({
    bundle,
    signingKey: keyPair.privateKey,
    keyId: 'local-key-1',
  });
  console.log('Grant token issued (first 60 chars):', token.slice(0, 60) + '...');

  // 4. Verify the token offline
  const result = await verifyGrantToken(token, keyPair.publicKey);
  console.log('Token valid:', result.valid);
  console.log('Scopes:', result.scopes);

  // 5. Audit logging with hash chain
  const chain = createAuditChain();

  logAuditEntry(chain, {
    agentId: 'gemma-assistant',
    agentDid: 'did:grantex:gemma-assistant',
    action: 'calendar.read',
    status: 'success',
    grantId: bundle.bundleId,
    principalId: 'user_alice',
  });

  logAuditEntry(chain, {
    agentId: 'gemma-assistant',
    agentDid: 'did:grantex:gemma-assistant',
    action: 'email.send',
    status: 'success',
    grantId: bundle.bundleId,
    principalId: 'user_alice',
    metadata: { recipient: 'bob@example.com', subject: 'Meeting notes' },
  });

  console.log('Audit chain entries:', chain.entries.length);

  // 6. Verify the hash chain
  const chainValid = verifyAuditChain(chain);
  console.log('Hash chain integrity:', chainValid ? 'valid' : 'broken');
}

main().catch(console.error);
`;

const ENV_EXAMPLE = `# Grantex Gemma — Environment Variables
# Copy this file to .env and fill in your values

# Optional: Grantex API key for online sync (not required for offline use)
GRANTEX_API_KEY=

# Optional: Base URL for Grantex auth service
GRANTEX_URL=https://grantex-auth-dd4mtrt2gq-uc.a.run.app
`;

const README_MD = `# Grantex Gemma Starter

Offline authorization for on-device AI agents using [Grantex Gemma](https://grantex.dev/for/gemma).

## Getting Started

\`\`\`bash
npm install
npx tsx index.ts
\`\`\`

## What This Does

1. **Generates a key pair** — Ed25519 for offline JWT signing
2. **Creates a consent bundle** — defines scopes and constraints
3. **Issues a grant token** — offline JWT with embedded permissions
4. **Verifies the token** — cryptographic verification without network
5. **Logs audit entries** — tamper-evident hash chain

## Next Steps

- Add more scopes and constraints to the consent bundle
- Write the audit chain to a JSONL file for persistence
- Integrate with your Gemma model's tool-calling flow
- Use \`grantex verify <token>\` to inspect tokens from the CLI

## Documentation

- [Grantex Gemma Guide](https://docs.grantex.dev/gemma/overview)
- [Grantex SDK Reference](https://docs.grantex.dev/sdk/typescript)
- [Protocol Specification](https://docs.grantex.dev/protocol/spec)
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["*.ts"]
}
`;

export function initCommand(): Command {
  const cmd = new Command('init').description('Scaffold a new Grantex project');

  cmd
    .command('gemma')
    .description('Create a starter project for @grantex/gemma (offline agent auth)')
    .option('--dir <directory>', 'Target directory (default: ./grantex-gemma-starter)')
    .action(async (opts: { dir?: string }) => {
      const targetDir = resolve(opts.dir ?? 'grantex-gemma-starter');

      if (existsSync(targetDir)) {
        if (isJsonMode()) {
          console.log(JSON.stringify({ error: `Directory already exists: ${targetDir}` }));
        } else {
          console.error(chalk.red('\u2717') + ` Directory already exists: ${targetDir}`);
        }
        process.exit(1);
        return;
      }

      mkdirSync(targetDir, { recursive: true });

      const files: Array<[string, string]> = [
        ['package.json', PACKAGE_JSON],
        ['index.ts', INDEX_TS],
        ['.env.example', ENV_EXAMPLE],
        ['README.md', README_MD],
        ['tsconfig.json', TSCONFIG],
      ];

      for (const [name, content] of files) {
        writeFileSync(join(targetDir, name), content, 'utf8');
      }

      if (isJsonMode()) {
        console.log(JSON.stringify({
          created: targetDir,
          files: files.map(([name]) => name),
        }, null, 2));
        return;
      }

      console.log(chalk.green('\u2713') + ` Project created at ${targetDir}`);
      console.log('');
      console.log('  Files created:');
      for (const [name] of files) {
        console.log(`    ${chalk.dim('\u2502')} ${name}`);
      }
      console.log('');
      console.log('  Next steps:');
      console.log(`    cd ${opts.dir ?? 'grantex-gemma-starter'}`);
      console.log('    npm install');
      console.log('    npx tsx index.ts');
      console.log('');
    });

  return cmd;
}
