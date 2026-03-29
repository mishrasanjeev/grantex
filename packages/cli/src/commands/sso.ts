import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function ssoCommand(): Command {
  const cmd = new Command('sso').description('Manage SSO configuration');

  // ── Enterprise SSO Connections ──────────────────────────────────────────
  const connections = new Command('connections').description('Manage SSO connections');

  connections
    .command('list')
    .description('List all SSO connections')
    .action(async () => {
      const client = await requireClient();
      const { connections: list } = await client.sso.listConnections();
      printTable(
        list.map((c) => ({
          ID: c.id,
          NAME: c.name,
          PROTOCOL: c.protocol.toUpperCase(),
          STATUS: c.status,
          DOMAINS: c.domains.join(', ') || '—',
          ENFORCE: c.enforce ? 'yes' : 'no',
          JIT: c.jitProvisioning ? 'yes' : 'no',
          CREATED: shortDate(c.createdAt),
        })),
        ['ID', 'NAME', 'PROTOCOL', 'STATUS', 'DOMAINS', 'ENFORCE', 'JIT', 'CREATED'],
        list.map((c) => ({ ...c })),
      );
    });

  connections
    .command('create')
    .description('Create a new SSO connection')
    .requiredOption('--name <name>', 'Connection name')
    .requiredOption('--protocol <protocol>', 'Protocol: oidc or saml')
    .option('--issuer-url <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client ID')
    .option('--client-secret <secret>', 'OIDC client secret')
    .option('--idp-entity-id <id>', 'SAML IdP entity ID')
    .option('--idp-sso-url <url>', 'SAML IdP SSO URL')
    .option('--idp-certificate <cert>', 'SAML IdP certificate (PEM)')
    .option('--sp-entity-id <id>', 'SAML SP entity ID')
    .option('--sp-acs-url <url>', 'SAML SP ACS URL')
    .option('--domains <domains>', 'Comma-separated email domains')
    .option('--jit-provisioning', 'Enable just-in-time user provisioning')
    .option('--enforce', 'Enforce SSO for matched domains')
    .option('--group-attribute <attr>', 'IdP attribute for group membership')
    .option('--group-mappings <json>', 'Group-to-scope mappings as JSON string')
    .option('--default-scopes <scopes>', 'Comma-separated default scopes')
    .action(async (opts: {
      name: string;
      protocol: string;
      issuerUrl?: string;
      clientId?: string;
      clientSecret?: string;
      idpEntityId?: string;
      idpSsoUrl?: string;
      idpCertificate?: string;
      spEntityId?: string;
      spAcsUrl?: string;
      domains?: string;
      jitProvisioning?: true;
      enforce?: true;
      groupAttribute?: string;
      groupMappings?: string;
      defaultScopes?: string;
    }) => {
      const client = await requireClient();
      const params: Record<string, unknown> = {
        name: opts.name,
        protocol: opts.protocol,
      };
      if (opts.issuerUrl !== undefined) params.issuerUrl = opts.issuerUrl;
      if (opts.clientId !== undefined) params.clientId = opts.clientId;
      if (opts.clientSecret !== undefined) params.clientSecret = opts.clientSecret;
      if (opts.idpEntityId !== undefined) params.idpEntityId = opts.idpEntityId;
      if (opts.idpSsoUrl !== undefined) params.idpSsoUrl = opts.idpSsoUrl;
      if (opts.idpCertificate !== undefined) params.idpCertificate = opts.idpCertificate;
      if (opts.spEntityId !== undefined) params.spEntityId = opts.spEntityId;
      if (opts.spAcsUrl !== undefined) params.spAcsUrl = opts.spAcsUrl;
      if (opts.domains !== undefined) params.domains = opts.domains.split(',').map((d) => d.trim());
      if (opts.jitProvisioning !== undefined) params.jitProvisioning = true;
      if (opts.enforce !== undefined) params.enforce = true;
      if (opts.groupAttribute !== undefined) params.groupAttribute = opts.groupAttribute;
      if (opts.groupMappings !== undefined) params.groupMappings = JSON.parse(opts.groupMappings);
      if (opts.defaultScopes !== undefined) params.defaultScopes = opts.defaultScopes.split(',').map((s) => s.trim());

      const conn = await client.sso.createConnection(params as unknown as Parameters<typeof client.sso.createConnection>[0]);
      if (isJsonMode()) {
        console.log(JSON.stringify(conn, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SSO connection created: ${conn.id}`);
      printRecord({
        id: conn.id,
        name: conn.name,
        protocol: conn.protocol,
        status: conn.status,
        domains: conn.domains.join(', ') || '—',
      });
    });

  connections
    .command('get <id>')
    .description('Get an SSO connection by ID')
    .action(async (id: string) => {
      const client = await requireClient();
      const conn = await client.sso.getConnection(id);
      if (isJsonMode()) {
        console.log(JSON.stringify(conn, null, 2));
        return;
      }
      printRecord({
        id: conn.id,
        name: conn.name,
        protocol: conn.protocol,
        status: conn.status,
        domains: conn.domains.join(', ') || '—',
        jitProvisioning: conn.jitProvisioning ? 'yes' : 'no',
        enforce: conn.enforce ? 'yes' : 'no',
        groupAttribute: conn.groupAttribute ?? '—',
        defaultScopes: conn.defaultScopes.join(', ') || '—',
        createdAt: shortDate(conn.createdAt),
        updatedAt: shortDate(conn.updatedAt),
      });
    });

  connections
    .command('update <id>')
    .description('Update an SSO connection')
    .option('--name <name>', 'Connection name')
    .option('--status <status>', 'Connection status: active, inactive, or testing')
    .option('--issuer-url <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client ID')
    .option('--client-secret <secret>', 'OIDC client secret')
    .option('--idp-entity-id <id>', 'SAML IdP entity ID')
    .option('--idp-sso-url <url>', 'SAML IdP SSO URL')
    .option('--idp-certificate <cert>', 'SAML IdP certificate (PEM)')
    .option('--sp-entity-id <id>', 'SAML SP entity ID')
    .option('--sp-acs-url <url>', 'SAML SP ACS URL')
    .option('--domains <domains>', 'Comma-separated email domains')
    .option('--jit-provisioning <bool>', 'Enable just-in-time provisioning (true/false)')
    .option('--enforce <bool>', 'Enforce SSO for matched domains (true/false)')
    .option('--group-attribute <attr>', 'IdP attribute for group membership')
    .option('--group-mappings <json>', 'Group-to-scope mappings as JSON string')
    .option('--default-scopes <scopes>', 'Comma-separated default scopes')
    .action(async (id: string, opts: {
      name?: string;
      status?: string;
      issuerUrl?: string;
      clientId?: string;
      clientSecret?: string;
      idpEntityId?: string;
      idpSsoUrl?: string;
      idpCertificate?: string;
      spEntityId?: string;
      spAcsUrl?: string;
      domains?: string;
      jitProvisioning?: string;
      enforce?: string;
      groupAttribute?: string;
      groupMappings?: string;
      defaultScopes?: string;
    }) => {
      const client = await requireClient();
      const params: Record<string, unknown> = {};
      if (opts.name !== undefined) params.name = opts.name;
      if (opts.status !== undefined) params.status = opts.status;
      if (opts.issuerUrl !== undefined) params.issuerUrl = opts.issuerUrl;
      if (opts.clientId !== undefined) params.clientId = opts.clientId;
      if (opts.clientSecret !== undefined) params.clientSecret = opts.clientSecret;
      if (opts.idpEntityId !== undefined) params.idpEntityId = opts.idpEntityId;
      if (opts.idpSsoUrl !== undefined) params.idpSsoUrl = opts.idpSsoUrl;
      if (opts.idpCertificate !== undefined) params.idpCertificate = opts.idpCertificate;
      if (opts.spEntityId !== undefined) params.spEntityId = opts.spEntityId;
      if (opts.spAcsUrl !== undefined) params.spAcsUrl = opts.spAcsUrl;
      if (opts.domains !== undefined) params.domains = opts.domains.split(',').map((d) => d.trim());
      if (opts.jitProvisioning !== undefined) params.jitProvisioning = opts.jitProvisioning === 'true';
      if (opts.enforce !== undefined) params.enforce = opts.enforce === 'true';
      if (opts.groupAttribute !== undefined) params.groupAttribute = opts.groupAttribute;
      if (opts.groupMappings !== undefined) params.groupMappings = JSON.parse(opts.groupMappings);
      if (opts.defaultScopes !== undefined) params.defaultScopes = opts.defaultScopes.split(',').map((s) => s.trim());

      if (Object.keys(params).length === 0) {
        console.error('Error: provide at least one field to update.');
        process.exit(1);
      }

      const conn = await client.sso.updateConnection(id, params as Parameters<typeof client.sso.updateConnection>[1]);
      if (isJsonMode()) {
        console.log(JSON.stringify(conn, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` SSO connection ${id} updated.`);
    });

  connections
    .command('delete <id>')
    .description('Delete an SSO connection')
    .action(async (id: string) => {
      const client = await requireClient();
      await client.sso.deleteConnection(id);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: id }));
        return;
      }
      console.log(chalk.green('✓') + ` SSO connection ${id} deleted.`);
    });

  connections
    .command('test <id>')
    .description('Test an SSO connection')
    .action(async (id: string) => {
      const client = await requireClient();
      const result = await client.sso.testConnection(id);
      if (isJsonMode()) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.success) {
        console.log(chalk.green('✓') + ' SSO connection test passed.');
      } else {
        console.log(chalk.red('✗') + ` SSO connection test failed: ${result.error ?? 'unknown error'}`);
      }
      const display: Record<string, string> = {
        success: result.success ? 'yes' : 'no',
        protocol: result.protocol,
      };
      if (result.issuer) display.issuer = result.issuer;
      if (result.authorizationEndpoint) display.authorizationEndpoint = result.authorizationEndpoint;
      if (result.tokenEndpoint) display.tokenEndpoint = result.tokenEndpoint;
      if (result.jwksUri) display.jwksUri = result.jwksUri;
      if (result.idpEntityId) display.idpEntityId = result.idpEntityId;
      if (result.idpSsoUrl) display.idpSsoUrl = result.idpSsoUrl;
      if (result.error) display.error = result.error;
      printRecord(display, { ...result });
    });

  cmd.addCommand(connections);

  // ── SSO enforcement ─────────────────────────────────────────────────────
  cmd
    .command('enforce')
    .description('Enable or disable SSO enforcement')
    .option('--enable', 'Enable SSO enforcement')
    .option('--disable', 'Disable SSO enforcement')
    .action(async (opts: { enable?: true; disable?: true }) => {
      if (!opts.enable && !opts.disable) {
        console.error('Error: specify --enable or --disable.');
        process.exit(1);
      }
      const client = await requireClient();
      const enforce = !!opts.enable;
      const res = await client.sso.setEnforcement({ enforce });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        chalk.green('✓') +
          ` SSO enforcement ${res.enforce ? 'enabled' : 'disabled'} for developer ${res.developerId}.`,
      );
    });

  // ── SSO sessions ────────────────────────────────────────────────────────
  const sessions = new Command('sessions').description('Manage SSO sessions');

  sessions
    .command('list')
    .description('List active SSO sessions')
    .action(async () => {
      const client = await requireClient();
      const { sessions: list } = await client.sso.listSessions();
      printTable(
        list.map((s) => ({
          ID: s.id,
          CONNECTION: s.connectionId,
          EMAIL: s.email ?? '—',
          NAME: s.name ?? '—',
          GROUPS: s.groups.join(', ') || '—',
          EXPIRES: shortDate(s.expiresAt),
          CREATED: shortDate(s.createdAt),
        })),
        ['ID', 'CONNECTION', 'EMAIL', 'NAME', 'GROUPS', 'EXPIRES', 'CREATED'],
        list.map((s) => ({ ...s })),
      );
    });

  sessions
    .command('revoke <id>')
    .description('Revoke an SSO session')
    .action(async (id: string) => {
      const client = await requireClient();
      await client.sso.revokeSession(id);
      if (isJsonMode()) {
        console.log(JSON.stringify({ revoked: id }));
        return;
      }
      console.log(chalk.green('✓') + ` SSO session ${id} revoked.`);
    });

  cmd.addCommand(sessions);

  // ── Legacy commands (backward compatible) ───────────────────────────────
  cmd
    .command('get')
    .description('Show current SSO configuration')
    .action(async () => {
      const client = await requireClient();
      const config = await client.sso.getConfig();
      printRecord(
        {
          issuerUrl: config.issuerUrl,
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          updatedAt: shortDate(config.updatedAt),
        },
        { ...config },
      );
    });

  cmd
    .command('configure')
    .description('Create or update SSO configuration')
    .requiredOption('--issuer-url <url>', 'OIDC issuer URL')
    .requiredOption('--client-id <id>', 'OIDC client ID')
    .requiredOption('--client-secret <secret>', 'OIDC client secret')
    .requiredOption('--redirect-uri <uri>', 'Callback redirect URI')
    .action(async (opts: { issuerUrl: string; clientId: string; clientSecret: string; redirectUri: string }) => {
      const client = await requireClient();
      await client.sso.createConfig({
        issuerUrl: opts.issuerUrl,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        redirectUri: opts.redirectUri,
      });
      console.log(chalk.green('✓') + ' SSO configuration saved.');
    });

  cmd
    .command('delete')
    .description('Delete SSO configuration')
    .action(async () => {
      const client = await requireClient();
      await client.sso.deleteConfig();
      console.log(chalk.green('✓') + ' SSO configuration deleted.');
    });

  cmd
    .command('login-url <org>')
    .description('Get the SSO login URL for an organization')
    .action(async (org: string) => {
      const client = await requireClient();
      const { authorizeUrl } = await client.sso.getLoginUrl(org);
      if (isJsonMode()) {
        console.log(JSON.stringify({ authorizeUrl }));
        return;
      }
      console.log(authorizeUrl);
    });

  cmd
    .command('callback')
    .description('Handle an SSO callback (exchange code + state for user info)')
    .requiredOption('--code <code>', 'Authorization code from SSO provider')
    .requiredOption('--state <state>', 'State parameter from SSO redirect')
    .action(async (opts: { code: string; state: string }) => {
      const client = await requireClient();
      const res = await client.sso.handleCallback(opts.code, opts.state);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        email: res.email ?? '—',
        name: res.name ?? '—',
        sub: res.sub ?? '—',
        developerId: res.developerId,
      });
    });

  return cmd;
}
