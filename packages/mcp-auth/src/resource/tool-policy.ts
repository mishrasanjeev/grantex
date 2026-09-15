/**
 * Which scopes an MCP tool call needs, derived from Grantex tool manifests or
 * declared directly.
 *
 * Extension point for manifest 0.6: {@link toolPolicyFromManifests} accepts
 * the plain manifest data (`spec/manifest-0.6.schema.json`), in which a tool
 * is either a permission string or an object with `permission`,
 * `allowed_purposes`, `caps`, `cost_units`, `requires_decision` and
 * `four_eyes_on`. A loaded SDK manifest can be passed as its JSON form. Only
 * the fields this package acts on are read — permission (for the scope) and
 * requires_decision (for the decision challenge); purposes and caps are kept
 * on the requirement for display and for enforcement elsewhere.
 */

export type Permission = 'read' | 'write' | 'delete' | 'admin';

const LEVELS: Record<Permission, number> = { read: 0, write: 1, delete: 2, admin: 3 };

export interface ManifestToolObject {
  permission: Permission;
  allowed_purposes?: string[];
  caps?: { per_hour?: number; per_day?: number; per_case?: number };
  cost_units?: Record<string, number>;
  requires_decision?: boolean;
  four_eyes_on?: string[];
}

/** A manifest as loaded from JSON (string or object tool values). */
export interface LoadedManifest {
  connector: string;
  version?: string;
  description?: string;
  tools: Record<string, Permission | ManifestToolObject>;
}

export interface ToolRequirement {
  /** The MCP tool name clients call. */
  name: string;
  connector?: string;
  /** Tool name inside its manifest. */
  tool: string;
  permission?: Permission;
  /** Scopes the challenge asks for when the grant does not cover the tool. */
  requiredScopes: string[];
  requiresDecision: boolean;
  allowedPurposes?: string[];
  caps?: ManifestToolObject['caps'];
  fourEyesOn?: string[];
}

export interface ToolPolicy {
  /** Every tool this server exposes, in declaration order. */
  readonly tools: readonly ToolRequirement[];
  /** Distinct scopes across all tools (for `scopes_supported`). */
  readonly scopesSupported: readonly string[];
  /** The requirement for a tool name, or `undefined` for a tool the policy does not know. */
  requirementFor(name: string): ToolRequirement | undefined;
  /** Whether the granted scopes satisfy the requirement (scope hierarchies included). */
  isSatisfied(requirement: ToolRequirement, grantedScopes: readonly string[]): boolean;
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVELS, value);
}

/** `tool:<connector>:<permission>`, the scope form `enforce()` resolves. */
export function manifestScope(connector: string, permission: Permission): string {
  return `tool:${connector}:${permission}`;
}

/**
 * Highest permission a grant holds on a connector, reading `tool:` and
 * `agenticorg:` scopes with any trailing resource or cap segments, exactly as
 * the SDK's enforce() does.
 */
export function grantedPermission(grantedScopes: readonly string[], connector: string): Permission | undefined {
  let best: Permission | undefined;
  for (const scope of grantedScopes) {
    const [prefix, scopeConnector, permission] = scope.split(':');
    if ((prefix === 'tool' || prefix === 'agenticorg') && scopeConnector === connector && isPermission(permission)) {
      if (best === undefined || LEVELS[permission] > LEVELS[best]) best = permission;
    }
  }
  return best;
}

export interface ManifestPolicyOptions {
  /**
   * MCP tool name for a manifest tool (default: the manifest tool name). Two
   * manifest tools mapping to one name is refused, since a call could not be
   * attributed to one connector.
   */
  toolName?: (connector: string, tool: string) => string;
}

/** Builds a policy from loaded manifests. Throws on anything ambiguous or invalid. */
export function toolPolicyFromManifests(manifests: readonly LoadedManifest[], options: ManifestPolicyOptions = {}): ToolPolicy {
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new Error('toolPolicyFromManifests: at least one manifest is required');
  }
  const nameOf = options.toolName ?? ((_connector: string, tool: string) => tool);
  const requirements = new Map<string, ToolRequirement>();

  for (const manifest of manifests) {
    if (!manifest || typeof manifest.connector !== 'string' || manifest.connector.length === 0) {
      throw new Error('toolPolicyFromManifests: every manifest needs a connector');
    }
    if (!manifest.tools || typeof manifest.tools !== 'object' || Object.keys(manifest.tools).length === 0) {
      throw new Error(`toolPolicyFromManifests: manifest ${manifest.connector} declares no tools`);
    }
    for (const [tool, declaration] of Object.entries(manifest.tools)) {
      const object = typeof declaration === 'object' && declaration !== null ? (declaration as ManifestToolObject) : undefined;
      const permission = object ? object.permission : declaration;
      if (!isPermission(permission)) {
        throw new Error(`toolPolicyFromManifests: ${manifest.connector}.${tool} has an invalid permission`);
      }
      const requiresDecision = object?.requires_decision === true;
      if (object && object.requires_decision !== undefined && typeof object.requires_decision !== 'boolean') {
        throw new Error(`toolPolicyFromManifests: ${manifest.connector}.${tool} requires_decision must be a boolean`);
      }
      if (requiresDecision && permission === 'read') {
        throw new Error(`toolPolicyFromManifests: ${manifest.connector}.${tool} declares requires_decision on a read tool`);
      }
      const name = nameOf(manifest.connector, tool);
      if (requirements.has(name)) {
        throw new Error(`toolPolicyFromManifests: tool name "${name}" is declared by more than one manifest; use options.toolName`);
      }
      requirements.set(name, {
        name,
        connector: manifest.connector,
        tool,
        permission,
        requiredScopes: [manifestScope(manifest.connector, permission)],
        requiresDecision,
        ...(object?.allowed_purposes !== undefined ? { allowedPurposes: [...object.allowed_purposes] } : {}),
        ...(object?.caps !== undefined ? { caps: { ...object.caps } } : {}),
        ...(object?.four_eyes_on !== undefined ? { fourEyesOn: [...object.four_eyes_on] } : {}),
      });
    }
  }

  return buildPolicy([...requirements.values()], (requirement, granted) => {
    if (requirement.connector === undefined || requirement.permission === undefined) return false;
    const held = grantedPermission(granted, requirement.connector);
    return held !== undefined && LEVELS[held] >= LEVELS[requirement.permission];
  });
}

/**
 * Builds a policy from an explicit map of tool name to the scopes it needs
 * (all of them, compared exactly). Use `requiresDecision` for tools that also
 * need a decision grant.
 */
export function toolPolicyFromScopes(
  tools: Record<string, string[] | { scopes: string[]; requiresDecision?: boolean }>,
): ToolPolicy {
  const requirements: ToolRequirement[] = [];
  for (const [name, value] of Object.entries(tools)) {
    const scopes = Array.isArray(value) ? value : value.scopes;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string' && s.length > 0)) {
      throw new Error(`toolPolicyFromScopes: tool "${name}" needs an array of scope strings`);
    }
    requirements.push({
      name,
      tool: name,
      requiredScopes: [...scopes],
      requiresDecision: !Array.isArray(value) && value.requiresDecision === true,
    });
  }
  if (requirements.length === 0) throw new Error('toolPolicyFromScopes: at least one tool is required');
  return buildPolicy(requirements, (requirement, granted) => requirement.requiredScopes.every((s) => granted.includes(s)));
}

function buildPolicy(
  requirements: ToolRequirement[],
  satisfied: (requirement: ToolRequirement, granted: readonly string[]) => boolean,
): ToolPolicy {
  const byName = new Map(requirements.map((r) => [r.name, r]));
  const scopes = [...new Set(requirements.flatMap((r) => r.requiredScopes))];
  return {
    tools: requirements,
    scopesSupported: scopes,
    requirementFor: (name) => (typeof name === 'string' ? byName.get(name) : undefined),
    isSatisfied: (requirement, granted) => byName.get(requirement.name) === requirement && satisfied(requirement, granted),
  };
}
