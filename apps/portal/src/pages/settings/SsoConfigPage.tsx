import { useState, useEffect } from 'react';
import {
  listSsoConnections,
  createSsoConnection,
  deleteSsoConnection,
  testSsoConnection,
  type SsoConnection,
  type CreateConnectionData,
} from '../../api/sso';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError } from '../../api/client';

type Protocol = 'oidc' | 'saml' | 'ldap';

const protocolOptions = [
  { value: 'oidc', label: 'OIDC' },
  { value: 'saml', label: 'SAML' },
  { value: 'ldap', label: 'LDAP' },
];

const statusVariant: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  active: 'success',
  testing: 'warning',
  inactive: 'danger',
};

export function SsoConfigPage() {
  const [connections, setConnections] = useState<SsoConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SsoConnection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('oidc');
  const [domains, setDomains] = useState('');
  const [jitProvisioning, setJitProvisioning] = useState(false);
  const [enforce, setEnforce] = useState(false);

  // OIDC fields
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  // SAML fields
  const [idpEntityId, setIdpEntityId] = useState('');
  const [idpSsoUrl, setIdpSsoUrl] = useState('');
  const [idpCertificate, setIdpCertificate] = useState('');
  const [spEntityId, setSpEntityId] = useState('');
  const [spAcsUrl, setSpAcsUrl] = useState('');

  // LDAP fields
  const [ldapUrl, setLdapUrl] = useState('');
  const [ldapBindDn, setLdapBindDn] = useState('');
  const [ldapBindPassword, setLdapBindPassword] = useState('');
  const [ldapSearchBase, setLdapSearchBase] = useState('');
  const [ldapSearchFilter, setLdapSearchFilter] = useState('');
  const [ldapGroupSearchBase, setLdapGroupSearchBase] = useState('');
  const [ldapGroupSearchFilter, setLdapGroupSearchFilter] = useState('');
  const [ldapTlsEnabled, setLdapTlsEnabled] = useState(false);

  const { show } = useToast();

  useEffect(() => {
    loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadConnections() {
    setLoading(true);
    try {
      const res = await listSsoConnections();
      setConnections(res.connections);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setConnections([]);
      } else {
        show('Failed to load SSO connections', 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setName('');
    setProtocol('oidc');
    setDomains('');
    setJitProvisioning(false);
    setEnforce(false);
    setIssuerUrl('');
    setClientId('');
    setClientSecret('');
    setIdpEntityId('');
    setIdpSsoUrl('');
    setIdpCertificate('');
    setSpEntityId('');
    setSpAcsUrl('');
    setLdapUrl('');
    setLdapBindDn('');
    setLdapBindPassword('');
    setLdapSearchBase('');
    setLdapSearchFilter('');
    setLdapGroupSearchBase('');
    setLdapGroupSearchFilter('');
    setLdapTlsEnabled(false);
  }

  function isFormValid(): boolean {
    if (!name) return false;
    if (protocol === 'oidc' && (!issuerUrl || !clientId || !clientSecret)) return false;
    if (protocol === 'saml' && (!idpEntityId || !idpSsoUrl || !idpCertificate)) return false;
    if (protocol === 'ldap' && (!ldapUrl || !ldapBindDn || !ldapBindPassword || !ldapSearchBase)) return false;
    return true;
  }

  async function handleCreate() {
    if (!isFormValid()) return;
    setCreating(true);
    try {
      const data: CreateConnectionData = {
        name,
        protocol,
        ...(domains ? { domains: domains.split(',').map((d) => d.trim()).filter(Boolean) } : {}),
        ...(jitProvisioning ? { jitProvisioning: true } : {}),
        ...(enforce ? { enforce: true } : {}),
      };

      if (protocol === 'oidc') {
        data.issuerUrl = issuerUrl;
        data.clientId = clientId;
        data.clientSecret = clientSecret;
      } else if (protocol === 'saml') {
        data.idpEntityId = idpEntityId;
        data.idpSsoUrl = idpSsoUrl;
        data.idpCertificate = idpCertificate;
        if (spEntityId) data.spEntityId = spEntityId;
        if (spAcsUrl) data.spAcsUrl = spAcsUrl;
      } else if (protocol === 'ldap') {
        data.ldapUrl = ldapUrl;
        data.ldapBindDn = ldapBindDn;
        data.ldapBindPassword = ldapBindPassword;
        data.ldapSearchBase = ldapSearchBase;
        if (ldapSearchFilter) data.ldapSearchFilter = ldapSearchFilter;
        if (ldapGroupSearchBase) data.ldapGroupSearchBase = ldapGroupSearchBase;
        if (ldapGroupSearchFilter) data.ldapGroupSearchFilter = ldapGroupSearchFilter;
        if (ldapTlsEnabled) data.ldapTlsEnabled = true;
      }

      await createSsoConnection(data);
      show('SSO connection created', 'success');
      setShowCreate(false);
      resetForm();
      await loadConnections();
    } catch {
      show('Failed to create SSO connection', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSsoConnection(deleteTarget.id);
      show('SSO connection deleted', 'success');
      setDeleteTarget(null);
      await loadConnections();
    } catch {
      show('Failed to delete SSO connection', 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const result = await testSsoConnection(id);
      if (result.success) {
        show('Connection test passed', 'success');
      } else {
        show(`Connection test failed: ${result.error ?? 'unknown error'}`, 'error');
      }
    } catch {
      show('Failed to test connection', 'error');
    } finally {
      setTestingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const columns = [
    {
      key: 'name',
      header: 'Name',
      render: (row: SsoConnection) => (
        <span className="font-medium text-gx-text">{row.name}</span>
      ),
    },
    {
      key: 'protocol',
      header: 'Protocol',
      render: (row: SsoConnection) => (
        <Badge>{row.protocol.toUpperCase()}</Badge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row: SsoConnection) => (
        <Badge variant={statusVariant[row.status] ?? 'default'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'domains',
      header: 'Domains',
      render: (row: SsoConnection) => (
        <span className="text-sm text-gx-muted">{row.domains.join(', ') || '\u2014'}</span>
      ),
    },
    {
      key: 'enforce',
      header: 'Enforce',
      render: (row: SsoConnection) => (
        <span className="text-sm text-gx-muted">{row.enforce ? 'Yes' : 'No'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row: SsoConnection) => (
        <div className="flex items-center gap-2 justify-end">
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => { e.stopPropagation(); handleTest(row.id); }}
            disabled={testingId === row.id}
          >
            {testingId === row.id ? 'Testing...' : 'Test'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gx-text">SSO Connections</h1>
          <Badge>{connections.length}</Badge>
        </div>
        <Button size="sm" onClick={() => { resetForm(); setShowCreate(true); }}>
          Create Connection
        </Button>
      </div>

      <Card className="mb-6">
        {connections.length === 0 ? (
          <p className="text-sm text-gx-muted py-4 text-center">
            No SSO connections configured. Create one to enable single sign-on for your organization.
          </p>
        ) : (
          <Table
            columns={columns}
            data={connections}
            rowKey={(row) => row.id}
          />
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-gx-text mb-2">About SSO</h2>
        <p className="text-xs text-gx-muted leading-relaxed">
          Single Sign-On allows members of your organization to log in using your existing identity
          provider via OpenID Connect, SAML 2.0, or LDAP. SSO is available on the Enterprise plan.
        </p>
      </Card>

      {/* Create Connection Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create SSO Connection"
      >
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <Input
            label="Name"
            placeholder="e.g. Corporate Okta"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <Select
            label="Protocol"
            options={protocolOptions}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as Protocol)}
          />

          <Input
            label="Domains"
            hint="comma-separated"
            placeholder="corp.com, example.io"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />

          {/* OIDC-specific fields */}
          {protocol === 'oidc' && (
            <>
              <Input
                label="Issuer URL"
                placeholder="https://accounts.google.com"
                value={issuerUrl}
                onChange={(e) => setIssuerUrl(e.target.value)}
              />
              <Input
                label="Client ID"
                placeholder="your-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <Input
                label="Client Secret"
                placeholder="your-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </>
          )}

          {/* SAML-specific fields */}
          {protocol === 'saml' && (
            <>
              <Input
                label="IdP Entity ID"
                placeholder="urn:okta:entity-id"
                value={idpEntityId}
                onChange={(e) => setIdpEntityId(e.target.value)}
              />
              <Input
                label="IdP SSO URL"
                placeholder="https://idp.example.com/sso/saml"
                value={idpSsoUrl}
                onChange={(e) => setIdpSsoUrl(e.target.value)}
              />
              <Input
                label="IdP Certificate"
                hint="PEM format"
                placeholder="MIICert..."
                value={idpCertificate}
                onChange={(e) => setIdpCertificate(e.target.value)}
              />
              <Input
                label="SP Entity ID"
                hint="optional"
                placeholder="urn:grantex:sp"
                value={spEntityId}
                onChange={(e) => setSpEntityId(e.target.value)}
              />
              <Input
                label="SP ACS URL"
                hint="optional"
                placeholder="https://auth.grantex.dev/sso/callback/saml"
                value={spAcsUrl}
                onChange={(e) => setSpAcsUrl(e.target.value)}
              />
            </>
          )}

          {/* LDAP-specific fields */}
          {protocol === 'ldap' && (
            <>
              <Input
                label="LDAP URL"
                placeholder="ldap://ldap.corp.com:389"
                value={ldapUrl}
                onChange={(e) => setLdapUrl(e.target.value)}
              />
              <Input
                label="Bind DN"
                placeholder="cn=admin,dc=corp,dc=com"
                value={ldapBindDn}
                onChange={(e) => setLdapBindDn(e.target.value)}
              />
              <Input
                label="Bind Password"
                placeholder="service account password"
                type="password"
                value={ldapBindPassword}
                onChange={(e) => setLdapBindPassword(e.target.value)}
              />
              <Input
                label="Search Base"
                placeholder="ou=users,dc=corp,dc=com"
                value={ldapSearchBase}
                onChange={(e) => setLdapSearchBase(e.target.value)}
              />
              <Input
                label="Search Filter"
                hint="optional, default: (uid={{username}})"
                placeholder="(uid={{username}})"
                value={ldapSearchFilter}
                onChange={(e) => setLdapSearchFilter(e.target.value)}
              />
              <Input
                label="Group Search Base"
                hint="optional"
                placeholder="ou=groups,dc=corp,dc=com"
                value={ldapGroupSearchBase}
                onChange={(e) => setLdapGroupSearchBase(e.target.value)}
              />
              <Input
                label="Group Search Filter"
                hint="optional, default: (member={{dn}})"
                placeholder="(member={{dn}})"
                value={ldapGroupSearchFilter}
                onChange={(e) => setLdapGroupSearchFilter(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <input
                  id="ldap-tls"
                  type="checkbox"
                  checked={ldapTlsEnabled}
                  onChange={(e) => setLdapTlsEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-gx-border bg-gx-bg text-gx-accent focus:ring-gx-accent"
                />
                <label htmlFor="ldap-tls" className="text-sm font-medium text-gx-text">
                  Enable TLS
                </label>
              </div>
            </>
          )}

          {/* Common toggles */}
          <div className="flex items-center gap-6 pt-2">
            <div className="flex items-center gap-3">
              <input
                id="jit-provisioning"
                type="checkbox"
                checked={jitProvisioning}
                onChange={(e) => setJitProvisioning(e.target.checked)}
                className="h-4 w-4 rounded border-gx-border bg-gx-bg text-gx-accent focus:ring-gx-accent"
              />
              <label htmlFor="jit-provisioning" className="text-sm font-medium text-gx-text">
                JIT Provisioning
              </label>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="enforce-sso"
                type="checkbox"
                checked={enforce}
                onChange={(e) => setEnforce(e.target.checked)}
                className="h-4 w-4 rounded border-gx-border bg-gx-bg text-gx-accent focus:ring-gx-accent"
              />
              <label htmlFor="enforce-sso" className="text-sm font-medium text-gx-text">
                Enforce SSO
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gx-border mt-4">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!isFormValid() || creating}
            >
              {creating ? 'Creating...' : 'Create Connection'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete SSO Connection"
        message={`This will permanently delete the "${deleteTarget?.name ?? ''}" SSO connection. Users authenticating through this connection will lose access.`}
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  );
}
