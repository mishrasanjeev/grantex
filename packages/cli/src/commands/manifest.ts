import { Command } from 'commander';
import chalk from 'chalk';
import { isJsonMode } from '../format.js';

// Bundled manifest metadata (connector name → tool count + category)
const BUNDLED_MANIFESTS: { connector: string; tools: number; category: string }[] = [
  // Finance
  { connector: 'banking_aa', tools: 5, category: 'finance' },
  { connector: 'gstn', tools: 8, category: 'finance' },
  { connector: 'netsuite', tools: 8, category: 'finance' },
  { connector: 'oracle_fusion', tools: 10, category: 'finance' },
  { connector: 'quickbooks', tools: 6, category: 'finance' },
  { connector: 'sap', tools: 7, category: 'finance' },
  { connector: 'stripe', tools: 8, category: 'finance' },
  { connector: 'tally', tools: 6, category: 'finance' },
  { connector: 'zoho_books', tools: 7, category: 'finance' },
  { connector: 'pinelabs_plural', tools: 6, category: 'finance' },
  { connector: 'income_tax_india', tools: 7, category: 'finance' },
  // HR
  { connector: 'darwinbox', tools: 10, category: 'hr' },
  { connector: 'docusign', tools: 6, category: 'hr' },
  { connector: 'epfo', tools: 6, category: 'hr' },
  { connector: 'greenhouse', tools: 8, category: 'hr' },
  { connector: 'keka', tools: 6, category: 'hr' },
  { connector: 'linkedin_talent', tools: 6, category: 'hr' },
  { connector: 'okta', tools: 8, category: 'hr' },
  { connector: 'zoom', tools: 6, category: 'hr' },
  // Marketing
  { connector: 'salesforce', tools: 6, category: 'marketing' },
  { connector: 'hubspot', tools: 13, category: 'marketing' },
  { connector: 'mailchimp', tools: 10, category: 'marketing' },
  { connector: 'google_ads', tools: 5, category: 'marketing' },
  { connector: 'meta_ads', tools: 5, category: 'marketing' },
  { connector: 'linkedin_ads', tools: 4, category: 'marketing' },
  { connector: 'ga4', tools: 6, category: 'marketing' },
  { connector: 'mixpanel', tools: 5, category: 'marketing' },
  { connector: 'moengage', tools: 6, category: 'marketing' },
  { connector: 'ahrefs', tools: 5, category: 'marketing' },
  { connector: 'bombora', tools: 4, category: 'marketing' },
  { connector: 'brandwatch', tools: 5, category: 'marketing' },
  { connector: 'buffer', tools: 5, category: 'marketing' },
  { connector: 'g2', tools: 4, category: 'marketing' },
  { connector: 'trustradius', tools: 4, category: 'marketing' },
  { connector: 'wordpress', tools: 7, category: 'marketing' },
  // Ops
  { connector: 'jira', tools: 11, category: 'ops' },
  { connector: 'confluence', tools: 6, category: 'ops' },
  { connector: 'servicenow', tools: 6, category: 'ops' },
  { connector: 'zendesk', tools: 8, category: 'ops' },
  { connector: 'pagerduty', tools: 6, category: 'ops' },
  { connector: 'sanctions_api', tools: 5, category: 'ops' },
  { connector: 'mca_portal', tools: 4, category: 'ops' },
  // Comms
  { connector: 'gmail', tools: 4, category: 'comms' },
  { connector: 'slack', tools: 7, category: 'comms' },
  { connector: 'github', tools: 9, category: 'comms' },
  { connector: 'google_calendar', tools: 5, category: 'comms' },
  { connector: 's3', tools: 6, category: 'comms' },
  { connector: 'sendgrid', tools: 7, category: 'comms' },
  { connector: 'twilio', tools: 5, category: 'comms' },
  { connector: 'twitter', tools: 6, category: 'comms' },
  { connector: 'whatsapp', tools: 5, category: 'comms' },
  { connector: 'youtube', tools: 6, category: 'comms' },
  { connector: 'langsmith', tools: 5, category: 'comms' },
];

export function manifestCommand(): Command {
  const cmd = new Command('manifest').description('Manage tool manifests for scope enforcement');

  /* ── list ─────────────────────────────────────────────────────────── */
  cmd
    .command('list')
    .description('List available pre-built manifests')
    .option('--category <category>', 'Filter by category (finance, hr, marketing, ops, comms)')
    .action((opts: { category?: string }) => {
      let manifests = BUNDLED_MANIFESTS;
      if (opts.category) {
        manifests = manifests.filter((m) => m.category === opts.category!.toLowerCase());
      }

      if (isJsonMode()) {
        console.log(JSON.stringify(manifests, null, 2));
        return;
      }

      const totalTools = manifests.reduce((sum, m) => sum + m.tools, 0);
      console.log(chalk.bold(`\nAvailable manifests (${manifests.length} connectors, ${totalTools} tools):\n`));

      const categories = [...new Set(manifests.map((m) => m.category))];
      for (const cat of categories) {
        console.log(chalk.dim(`  ${cat.toUpperCase()}`));
        for (const m of manifests.filter((x) => x.category === cat)) {
          console.log(`    ${chalk.cyan(m.connector.padEnd(20))} ${String(m.tools).padStart(3)} tools`);
        }
        console.log();
      }

      console.log(chalk.dim(`  Usage: from grantex.manifests.${manifests[0].connector} import manifest`));
    });

  /* ── show ─────────────────────────────────────────────────────────── */
  cmd
    .command('show <connector>')
    .description('Show tools and permissions for a manifest')
    .action(async (connector: string) => {
      try {
        // Dynamically import the manifest from the SDK
        const mod = await import(`@grantex/sdk/manifests/${connector}.js`);
        const manifest = Object.values(mod)[0] as { connector: string; tools: Record<string, string>; toolCount: number };

        if (isJsonMode()) {
          console.log(JSON.stringify(manifest, null, 2));
          return;
        }

        console.log(chalk.bold(`\n${manifest.connector} (${manifest.toolCount} tools):\n`));
        for (const [tool, perm] of Object.entries(manifest.tools)) {
          const color = perm === 'read' ? chalk.green : perm === 'write' ? chalk.yellow : perm === 'delete' ? chalk.red : chalk.magenta;
          console.log(`  ${tool.padEnd(35)} → ${color(perm)}`);
        }
        console.log();
      } catch {
        console.error(chalk.red(`Manifest not found: ${connector}`));
        console.error(chalk.dim('Run `grantex manifest list` to see available manifests.'));
        process.exit(1);
      }
    });

  /* ── validate ─────────────────────────────────────────────────────── */
  cmd
    .command('validate')
    .description('Validate that tools have manifest coverage')
    .requiredOption('--agent-tools <tools>', 'Comma-separated tool names to check')
    .option('--connector <connector>', 'Connector to check against')
    .action(async (opts: { agentTools: string; connector?: string }) => {
      const toolNames = opts.agentTools.split(',').map((t) => t.trim());
      const results: { tool: string; connector: string; permission: string; status: string }[] = [];

      // Try to find each tool in loaded manifests
      for (const toolName of toolNames) {
        let found = false;
        for (const meta of BUNDLED_MANIFESTS) {
          if (opts.connector && meta.connector !== opts.connector) continue;
          try {
            const mod = await import(`@grantex/sdk/manifests/${meta.connector}.js`);
            const manifest = Object.values(mod)[0] as { tools: Record<string, string> };
            if (manifest.tools[toolName]) {
              results.push({
                tool: toolName,
                connector: meta.connector,
                permission: manifest.tools[toolName],
                status: 'found',
              });
              found = true;
              break;
            }
          } catch {
            continue;
          }
        }
        if (!found) {
          results.push({ tool: toolName, connector: '?', permission: '?', status: 'missing' });
        }
      }

      if (isJsonMode()) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      const missing = results.filter((r) => r.status === 'missing');
      for (const r of results) {
        const icon = r.status === 'found' ? chalk.green('✓') : chalk.red('✗');
        const perm = r.status === 'found'
          ? chalk.dim(` → ${r.permission} (${r.connector})`)
          : chalk.red(' — no manifest entry');
        console.log(`  ${icon} ${r.tool}${perm}`);
      }

      if (missing.length > 0) {
        console.log(chalk.yellow(`\n  ⚠ ${missing.length} tool(s) have no manifest entry (defaulting to read)`));
      } else {
        console.log(chalk.green(`\n  ✓ All ${results.length} tools have manifest entries`));
      }
    });

  /* ── load ─────────────────────────────────────────────────────────── */
  cmd
    .command('load <path>')
    .description('Load a JSON manifest file and display its contents')
    .action(async (manifestPath: string) => {
      const fs = await import('node:fs');
      if (!fs.existsSync(manifestPath)) {
        console.error(chalk.red(`File not found: ${manifestPath}`));
        process.exit(1);
      }
      const content = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (isJsonMode()) {
        console.log(JSON.stringify(content, null, 2));
        return;
      }
      const connector = content.connector ?? 'unknown';
      const tools = content.tools ?? {};
      const count = Object.keys(tools).length;
      console.log(chalk.bold(`\nLoaded manifest: ${chalk.cyan(connector)} (${count} tools)\n`));
      for (const [name, perm] of Object.entries(tools)) {
        const color = perm === 'read' ? chalk.green : perm === 'write' ? chalk.yellow : perm === 'delete' ? chalk.red : chalk.magenta;
        console.log(`  ${name.padEnd(35)} → ${color(String(perm))}`);
      }
      console.log();
    });

  /* ── generate ─────────────────────────────────────────────────────── */
  cmd
    .command('generate <path>')
    .description('Auto-generate a manifest from connector source code')
    .option('--connector <name>', 'Override connector name (default: derived from filename)')
    .option('--out <path>', 'Output file path (default: stdout)')
    .option('--recursive', 'Scan directory recursively')
    .option('--format <format>', 'Output format: json (default) or python')
    .action(async (sourcePath: string, opts: { connector?: string; out?: string; recursive?: boolean; format?: string }) => {
      const fs = await import('node:fs');
      const path = await import('node:path');

      let stats: import('node:fs').Stats;
      try {
        stats = fs.statSync(sourcePath);
      } catch {
        console.error(chalk.red(`File not found: ${sourcePath}`));
        process.exit(1);
      }
      if (stats.isDirectory()) {
        // Scan all Python/TypeScript files in directory
        const files = scanDir(sourcePath, opts.recursive ?? false);
        let totalManifests = 0;
        let totalTools = 0;
        for (const file of files) {
          const fileContent = fs.readFileSync(file, 'utf-8');
          const fileBasename = path.basename(file, path.extname(file));
          const fileTools: Record<string, string> = {};
          const pyPat = /self\._tool_registry\["(\w+)"\]/g;
          let m;
          while ((m = pyPat.exec(fileContent)) !== null) {
            fileTools[m[1]] = inferPermission(m[1]);
          }
          if (Object.keys(fileTools).length > 0) {
            const manifest = { connector: fileBasename, version: '1.0.0', tools: fileTools };
            if (opts.out) {
              const outPath = path.join(opts.out, `${fileBasename}.json`);
              fs.mkdirSync(path.dirname(outPath), { recursive: true });
              fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
            }
            totalManifests++;
            totalTools += Object.keys(fileTools).length;
          }
        }
        if (!isJsonMode()) {
          console.log(chalk.green(`Generated ${totalManifests} manifests (${totalTools} tools)`));
        }
        return;
      }

      const content = fs.readFileSync(sourcePath, 'utf-8');
      const basename = path.basename(sourcePath, path.extname(sourcePath));
      const connectorName = opts.connector ?? basename;

      // Extract tool names from _register_tools() or _tool_registry patterns
      const tools: Record<string, string> = {};

      // Python pattern: self._tool_registry["tool_name"] = self.method
      const pyPattern = /self\._tool_registry\["(\w+)"\]/g;
      let match;
      while ((match = pyPattern.exec(content)) !== null) {
        tools[match[1]] = inferPermission(match[1]);
      }

      // TypeScript pattern: this.tools.set('tool_name', ...) or tools: { tool_name: ... }
      const tsPattern = /["'](\w+)["']\s*:/g;
      if (Object.keys(tools).length === 0) {
        while ((match = tsPattern.exec(content)) !== null) {
          const name = match[1];
          if (name.length > 2 && !['name', 'type', 'description', 'version', 'auth', 'base', 'rate'].includes(name)) {
            tools[name] = inferPermission(name);
          }
        }
      }

      if (Object.keys(tools).length === 0) {
        console.error(chalk.yellow('No tools found in source file. Supported patterns:'));
        console.error(chalk.dim('  Python: self._tool_registry["tool_name"] = ...'));
        process.exit(1);
      }

      const manifest = {
        connector: connectorName,
        version: '1.0.0',
        description: `Auto-generated manifest for ${connectorName}`,
        tools,
      };

      if (opts.format === 'python') {
        const pyLines = [
          `from grantex.manifest import ToolManifest, Permission`,
          ``,
          `manifest = ToolManifest(`,
          `    connector="${connectorName}",`,
          `    description="Auto-generated manifest for ${connectorName}",`,
          `    tools={`,
        ];
        for (const [name, perm] of Object.entries(tools)) {
          const permConst = perm === 'read' ? 'Permission.READ' : perm === 'write' ? 'Permission.WRITE' : perm === 'delete' ? 'Permission.DELETE' : 'Permission.ADMIN';
          pyLines.push(`        "${name}": ${permConst},`);
        }
        pyLines.push(`    },`);
        pyLines.push(`)`);
        const pyContent = pyLines.join('\n') + '\n';
        if (opts.out) {
          fs.writeFileSync(opts.out, pyContent);
          console.log(chalk.green(`Python manifest written to ${opts.out}`));
        } else {
          console.log(pyContent);
        }
        return;
      }

      if (isJsonMode() || !opts.out) {
        console.log(JSON.stringify(manifest, null, 2));
      }

      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(manifest, null, 2) + '\n');
        console.log(chalk.green(`Manifest written to ${opts.out}`));
      }

      if (!isJsonMode() && !opts.out) {
        console.log('');
        console.log(chalk.dim(`Generated manifest for ${chalk.cyan(connectorName)} (${Object.keys(tools).length} tools)`));
        console.log(chalk.dim('Review permissions and save with --out <path>'));
      }
    });

  return cmd;
}

function scanDir(dir: string, recursive: boolean): string[] {
  const fs = require('node:fs');
  const path = require('node:path');
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...scanDir(full, true));
    } else if (entry.isFile() && (entry.name.endsWith('.py') || entry.name.endsWith('.ts'))) {
      results.push(full);
    }
  }
  return results;
}

function inferPermission(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/^(get_|list_|search_|query_|fetch_|check_|download_|read_|find_|run_report|export_|screen_|verify_|validate_)/.test(name)) return 'read';
  if (/^(delete_|remove_|void_|terminate_|revoke_|cancel_|reject_|purge_|drop_)/.test(name)) return 'delete';
  if (/^(run_payment|run_payroll|run_period|reset_|force_)/.test(name)) return 'admin';
  if (/^(create_|update_|post_|send_|upload_|apply_|file_|record_|push_|add_|generate_|initiate_|set_|move_|schedule_|advance_|transition_|submit_|complete_|acknowledge_|resolve_|assign_|provision_|transfer_|mutate_|track_|reconcile_|create$)/.test(name)) return 'write';
  return 'read'; // safe default
}
