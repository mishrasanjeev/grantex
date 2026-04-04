/**
 * Tool Manifest & Permission — scope enforcement for AI agent tool calls.
 *
 * A ToolManifest declares the permission level (read/write/delete/admin)
 * required for each tool on a connector. The `enforce()` method on the
 * Grantex client uses loaded manifests to check whether a grant token's
 * scopes allow a given tool call.
 *
 * @example
 * ```ts
 * import { ToolManifest, Permission } from '@grantex/sdk';
 *
 * const manifest = new ToolManifest({
 *   connector: 'salesforce',
 *   tools: {
 *     query: Permission.READ,
 *     create_lead: Permission.WRITE,
 *     delete_contact: Permission.DELETE,
 *   },
 * });
 * ```
 */

/* ------------------------------------------------------------------ */
/*  Permission                                                         */
/* ------------------------------------------------------------------ */

/** Permission levels for tool operations. */
export enum Permission {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  ADMIN = 'admin',
}

const PERMISSION_LEVELS: Record<Permission, number> = {
  [Permission.READ]: 0,
  [Permission.WRITE]: 1,
  [Permission.DELETE]: 2,
  [Permission.ADMIN]: 3,
};

/**
 * Check whether a granted permission level covers the required level.
 *
 * Hierarchy: `admin > delete > write > read`
 *
 * - A `write` scope covers `read` + `write` tools.
 * - A `delete` scope covers `read` + `write` + `delete` tools.
 * - An `admin` scope covers everything.
 */
export function permissionCovers(granted: string, required: string): boolean {
  const grantedLevel = PERMISSION_LEVELS[granted as Permission] ?? -1;
  const requiredLevel = PERMISSION_LEVELS[required as Permission] ?? 99;
  return grantedLevel >= requiredLevel;
}

/* ------------------------------------------------------------------ */
/*  ToolManifest                                                       */
/* ------------------------------------------------------------------ */

export interface ToolManifestOptions {
  /** Connector name (e.g., "salesforce", "hubspot"). */
  connector: string;
  /** Tool name → Permission mapping. */
  tools: Record<string, Permission>;
  /** Manifest version (default "1.0.0"). */
  version?: string;
  /** Human-readable description. */
  description?: string;
}

/**
 * Declares the required permission level for each tool on a connector.
 *
 * Load manifests via `grantex.loadManifest()` and they will be used
 * automatically by `grantex.enforce()`.
 */
export class ToolManifest {
  readonly connector: string;
  readonly tools: Record<string, Permission>;
  readonly version: string;
  readonly description: string;

  constructor(options: ToolManifestOptions) {
    if (!options.connector) {
      throw new Error('ToolManifest: connector name is required');
    }
    if (!options.tools || Object.keys(options.tools).length === 0) {
      throw new Error('ToolManifest: at least one tool is required');
    }
    for (const [name, perm] of Object.entries(options.tools)) {
      if (!Object.values(Permission).includes(perm as Permission)) {
        throw new Error(
          `ToolManifest: invalid permission "${perm}" for tool "${name}". Must be one of: ${Object.values(Permission).join(', ')}`,
        );
      }
    }

    this.connector = options.connector;
    this.tools = { ...options.tools };
    this.version = options.version ?? '1.0.0';
    this.description = options.description ?? '';
  }

  /** Get the declared permission for a tool. Returns undefined if not found. */
  getPermission(toolName: string): Permission | undefined {
    return this.tools[toolName];
  }

  /** Add or update a tool's permission in this manifest. */
  addTool(toolName: string, permission: Permission): void {
    (this.tools as Record<string, Permission>)[toolName] = permission;
  }

  /** Number of tools in this manifest. */
  get toolCount(): number {
    return Object.keys(this.tools).length;
  }

  /**
   * Create a ToolManifest from a JSON object (e.g., loaded from file).
   *
   * Expected shape:
   * ```json
   * { "connector": "salesforce", "tools": { "query": "read", ... } }
   * ```
   */
  static fromJSON(data: Record<string, unknown>): ToolManifest {
    const connector = data['connector'] as string | undefined;
    const tools = data['tools'] as Record<string, string> | undefined;
    if (!connector || !tools) {
      throw new Error('ToolManifest.fromJSON: missing "connector" or "tools" field');
    }
    return new ToolManifest({
      connector,
      tools: tools as Record<string, Permission>,
      version: (data['version'] as string) ?? '1.0.0',
      description: (data['description'] as string) ?? '',
    });
  }
}

/* ------------------------------------------------------------------ */
/*  EnforceResult                                                      */
/* ------------------------------------------------------------------ */

/** Result of a `grantex.enforce()` call. */
export interface EnforceResult {
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Human-readable reason if denied. */
  reason: string;
  /** Grant ID from the JWT (empty if token invalid). */
  grantId: string;
  /** Agent DID from the JWT (empty if token invalid). */
  agentDid: string;
  /** All scopes from the grant token. */
  scopes: string[];
  /** Resolved permission for the requested tool. */
  permission: string;
  /** Connector name. */
  connector: string;
  /** Tool name. */
  tool: string;
}

/** Options for `grantex.enforce()`. */
export interface EnforceOptions {
  /** The Grantex grant token (JWT). */
  grantToken: string;
  /** Connector name (e.g., "salesforce"). */
  connector: string;
  /** Tool name (e.g., "delete_contact"). */
  tool: string;
  /** Amount for capped scope enforcement (optional). */
  amount?: number;
}

/** Options for `grantex.wrapTool()`. */
export interface WrapToolOptions {
  /** Connector name. */
  connector: string;
  /** Tool name. */
  tool: string;
  /** Grant token — static string or getter function for dynamic tokens. */
  grantToken: string | (() => string);
}

/** Options for `grantex.enforceMiddleware()`. */
export interface EnforceMiddlewareOptions {
  /** Extract the grant token from the request (e.g., from Authorization header). */
  extractToken: (req: Record<string, unknown>) => string | undefined;
  /** Extract the connector name from the request. */
  extractConnector: (req: Record<string, unknown>) => string;
  /** Extract the tool name from the request. */
  extractTool: (req: Record<string, unknown>) => string;
}
