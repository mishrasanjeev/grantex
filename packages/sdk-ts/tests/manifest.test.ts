import { describe, it, expect } from 'vitest';
import { ToolManifest, Permission, permissionCovers } from '../src/manifest.js';

describe('ToolManifest', () => {
  const validOptions = {
    connector: 'salesforce',
    tools: {
      query: Permission.READ,
      create_lead: Permission.WRITE,
      delete_contact: Permission.DELETE,
      manage_org: Permission.ADMIN,
    },
  };

  describe('construction', () => {
    it('creates a manifest with valid options', () => {
      const manifest = new ToolManifest(validOptions);
      expect(manifest.connector).toBe('salesforce');
      expect(manifest.tools).toEqual(validOptions.tools);
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('');
    });

    it('accepts optional version and description', () => {
      const manifest = new ToolManifest({
        ...validOptions,
        version: '2.0.0',
        description: 'Salesforce connector manifest',
      });
      expect(manifest.version).toBe('2.0.0');
      expect(manifest.description).toBe('Salesforce connector manifest');
    });

    it('throws on empty connector name', () => {
      expect(
        () => new ToolManifest({ connector: '', tools: { query: Permission.READ } }),
      ).toThrow('ToolManifest: connector name is required');
    });

    it('throws on empty tools', () => {
      expect(
        () => new ToolManifest({ connector: 'salesforce', tools: {} }),
      ).toThrow('ToolManifest: at least one tool is required');
    });

    it('throws on invalid permission value', () => {
      expect(
        () =>
          new ToolManifest({
            connector: 'salesforce',
            tools: { query: 'execute' as Permission },
          }),
      ).toThrow(/invalid permission "execute" for tool "query"/);
    });

    it('copies tools object to avoid external mutation', () => {
      const tools = { query: Permission.READ };
      const manifest = new ToolManifest({ connector: 'test', tools });
      tools['query'] = Permission.ADMIN;
      expect(manifest.tools['query']).toBe(Permission.READ);
    });
  });

  describe('getPermission()', () => {
    it('returns correct permission for known tool', () => {
      const manifest = new ToolManifest(validOptions);
      expect(manifest.getPermission('query')).toBe(Permission.READ);
      expect(manifest.getPermission('create_lead')).toBe(Permission.WRITE);
      expect(manifest.getPermission('delete_contact')).toBe(Permission.DELETE);
      expect(manifest.getPermission('manage_org')).toBe(Permission.ADMIN);
    });

    it('returns undefined for unknown tool', () => {
      const manifest = new ToolManifest(validOptions);
      expect(manifest.getPermission('nonexistent')).toBeUndefined();
    });
  });

  describe('addTool()', () => {
    it('adds a new tool', () => {
      const manifest = new ToolManifest(validOptions);
      manifest.addTool('export_data', Permission.READ);
      expect(manifest.getPermission('export_data')).toBe(Permission.READ);
    });

    it('overwrites existing tool permission', () => {
      const manifest = new ToolManifest(validOptions);
      expect(manifest.getPermission('query')).toBe(Permission.READ);
      manifest.addTool('query', Permission.WRITE);
      expect(manifest.getPermission('query')).toBe(Permission.WRITE);
    });
  });

  describe('toolCount', () => {
    it('returns correct count', () => {
      const manifest = new ToolManifest(validOptions);
      expect(manifest.toolCount).toBe(4);
    });

    it('reflects added tools', () => {
      const manifest = new ToolManifest({
        connector: 'test',
        tools: { query: Permission.READ },
      });
      expect(manifest.toolCount).toBe(1);
      manifest.addTool('create', Permission.WRITE);
      expect(manifest.toolCount).toBe(2);
    });
  });

  describe('fromJSON()', () => {
    it('creates manifest from plain object', () => {
      const data = {
        connector: 'hubspot',
        tools: {
          search_contacts: 'read',
          create_deal: 'write',
        },
        version: '1.2.0',
        description: 'HubSpot tools',
      };
      const manifest = ToolManifest.fromJSON(data);
      expect(manifest.connector).toBe('hubspot');
      expect(manifest.getPermission('search_contacts')).toBe(Permission.READ);
      expect(manifest.getPermission('create_deal')).toBe(Permission.WRITE);
      expect(manifest.version).toBe('1.2.0');
      expect(manifest.description).toBe('HubSpot tools');
    });

    it('uses default version and description when absent', () => {
      const manifest = ToolManifest.fromJSON({
        connector: 'slack',
        tools: { send_message: 'write' },
      });
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('');
    });

    it('throws on missing connector', () => {
      expect(() =>
        ToolManifest.fromJSON({ tools: { query: 'read' } }),
      ).toThrow('ToolManifest.fromJSON: missing "connector" or "tools" field');
    });

    it('throws on missing tools', () => {
      expect(() =>
        ToolManifest.fromJSON({ connector: 'salesforce' }),
      ).toThrow('ToolManifest.fromJSON: missing "connector" or "tools" field');
    });

    it('throws on missing both connector and tools', () => {
      expect(() => ToolManifest.fromJSON({})).toThrow(
        'ToolManifest.fromJSON: missing "connector" or "tools" field',
      );
    });
  });
});

describe('permissionCovers', () => {
  it('admin covers all permission levels', () => {
    expect(permissionCovers('admin', 'read')).toBe(true);
    expect(permissionCovers('admin', 'write')).toBe(true);
    expect(permissionCovers('admin', 'delete')).toBe(true);
    expect(permissionCovers('admin', 'admin')).toBe(true);
  });

  it('delete covers read, write, and delete but not admin', () => {
    expect(permissionCovers('delete', 'read')).toBe(true);
    expect(permissionCovers('delete', 'write')).toBe(true);
    expect(permissionCovers('delete', 'delete')).toBe(true);
    expect(permissionCovers('delete', 'admin')).toBe(false);
  });

  it('write covers read and write but not delete or admin', () => {
    expect(permissionCovers('write', 'read')).toBe(true);
    expect(permissionCovers('write', 'write')).toBe(true);
    expect(permissionCovers('write', 'delete')).toBe(false);
    expect(permissionCovers('write', 'admin')).toBe(false);
  });

  it('read covers only read', () => {
    expect(permissionCovers('read', 'read')).toBe(true);
    expect(permissionCovers('read', 'write')).toBe(false);
    expect(permissionCovers('read', 'delete')).toBe(false);
    expect(permissionCovers('read', 'admin')).toBe(false);
  });

  it('returns false for unknown granted permission', () => {
    expect(permissionCovers('execute', 'read')).toBe(false);
  });

  it('returns false for unknown required permission', () => {
    expect(permissionCovers('admin', 'execute')).toBe(false);
  });
});
