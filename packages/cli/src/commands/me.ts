import { Command } from 'commander';
import { defaultConfigPath, loadConfig, resolveConfig } from '../config.js';
import { printRecord, shortDate, isJsonMode } from '../format.js';

export function meCommand(): Command {
  const cmd = new Command('me').description('Show your developer profile and settings');

  cmd.action(async () => {
    const fileConfig = await loadConfig(defaultConfigPath());
    const config = resolveConfig(fileConfig);

    if (!config) {
      console.error(
        'Error: Grantex is not configured.\n' +
          'Run:  grantex config set --url <url> --key <api-key>\n' +
          'Or set the GRANTEX_URL and GRANTEX_KEY environment variables.',
      );
      process.exit(1);
    }

    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/me`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body && typeof body === 'object' && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
      console.error(`Error: ${msg}`);
      process.exit(1);
    }

    const me = (await res.json()) as Record<string, unknown>;

    if (isJsonMode()) {
      console.log(JSON.stringify(me, null, 2));
      return;
    }

    printRecord({
      id: String(me.id ?? ''),
      name: String(me.name ?? ''),
      email: String(me.email ?? ''),
      mode: String(me.mode ?? ''),
      plan: String(me.plan ?? 'free'),
      fidoRequired: String(me.fidoRequired ?? false),
      createdAt: me.createdAt ? shortDate(String(me.createdAt)) : '',
    });
  });

  return cmd;
}
