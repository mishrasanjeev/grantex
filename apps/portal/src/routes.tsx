import { type RouteObject } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { Dashboard } from './pages/Dashboard';
import { AgentList } from './pages/agents/AgentList';
import { AgentForm } from './pages/agents/AgentForm';
import { AgentDetail } from './pages/agents/AgentDetail';
import { GrantList } from './pages/grants/GrantList';
import { GrantDetail } from './pages/grants/GrantDetail';
import { AuditLog } from './pages/audit/AuditLog';
import { AuditDetail } from './pages/audit/AuditDetail';
import { PolicyList } from './pages/policies/PolicyList';
import { PolicyForm } from './pages/policies/PolicyForm';
import { AnomalyList } from './pages/anomalies/AnomalyList';
import { ComplianceDashboard } from './pages/compliance/ComplianceDashboard';
import { BillingPage } from './pages/billing/BillingPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SsoConfigPage } from './pages/settings/SsoConfigPage';
import { ScimTokensPage } from './pages/settings/ScimTokensPage';
import { WebhookList } from './pages/webhooks/WebhookList';
import { WebhookDeliveries } from './pages/webhooks/WebhookDeliveries';
import { BudgetList } from './pages/budgets/BudgetList';
import { BudgetDetail } from './pages/budgets/BudgetDetail';
import { UsageDashboard } from './pages/usage/UsageDashboard';
import { DomainList } from './pages/domains/DomainList';
import { WebAuthnList } from './pages/webauthn/WebAuthnList';
import { CredentialList } from './pages/credentials/CredentialList';
import { EventList } from './pages/events/EventList';
import { BundleList } from './pages/bundles/BundleList';
import { BundleForm } from './pages/bundles/BundleForm';
import { BundleDetail } from './pages/bundles/BundleDetail';
import { McpServerList } from './pages/mcp/McpServerList';
import { McpServerForm } from './pages/mcp/McpServerForm';
import { McpServerDetail } from './pages/mcp/McpServerDetail';
import { RegistrySearch } from './pages/registry/RegistrySearch';
import { RegistryOrgDetail } from './pages/registry/RegistryOrgDetail';
import { RegisterOrgForm } from './pages/registry/RegisterOrgForm';
import { AdminPage } from './pages/admin/AdminPage';
import { ConsentRecordList } from './pages/dpdp/ConsentRecordList';
import { ConsentRecordDetail } from './pages/dpdp/ConsentRecordDetail';
import { GrievanceList } from './pages/dpdp/GrievanceList';
import { ExportPage } from './pages/dpdp/ExportPage';
import { NotFound } from './pages/NotFound';
import { RequireAuth } from './RequireAuth';

export const routes: RouteObject[] = [
  { path: '/dashboard/login', element: <Login /> },
  { path: '/dashboard/signup', element: <Signup /> },
  { path: '/dashboard/admin', element: <AdminPage /> },
  {
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/dashboard/agents', element: <AgentList /> },
      { path: '/dashboard/agents/new', element: <AgentForm /> },
      { path: '/dashboard/agents/:id', element: <AgentDetail /> },
      { path: '/dashboard/agents/:id/edit', element: <AgentForm /> },
      { path: '/dashboard/grants', element: <GrantList /> },
      { path: '/dashboard/grants/:id', element: <GrantDetail /> },
      { path: '/dashboard/bundles', element: <BundleList /> },
      { path: '/dashboard/bundles/new', element: <BundleForm /> },
      { path: '/dashboard/bundles/:bundleId', element: <BundleDetail /> },
      { path: '/dashboard/audit', element: <AuditLog /> },
      { path: '/dashboard/audit/:id', element: <AuditDetail /> },
      { path: '/dashboard/webhooks', element: <WebhookList /> },
      { path: '/dashboard/webhooks/:id/deliveries', element: <WebhookDeliveries /> },
      { path: '/dashboard/policies', element: <PolicyList /> },
      { path: '/dashboard/policies/new', element: <PolicyForm /> },
      { path: '/dashboard/policies/:id/edit', element: <PolicyForm /> },
      { path: '/dashboard/anomalies', element: <AnomalyList /> },
      { path: '/dashboard/compliance', element: <ComplianceDashboard /> },
      { path: '/dashboard/budgets', element: <BudgetList /> },
      { path: '/dashboard/budgets/:grantId', element: <BudgetDetail /> },
      { path: '/dashboard/usage', element: <UsageDashboard /> },
      { path: '/dashboard/domains', element: <DomainList /> },
      { path: '/dashboard/webauthn', element: <WebAuthnList /> },
      { path: '/dashboard/credentials', element: <CredentialList /> },
      { path: '/dashboard/events', element: <EventList /> },
      { path: '/dashboard/mcp', element: <McpServerList /> },
      { path: '/dashboard/mcp/new', element: <McpServerForm /> },
      { path: '/dashboard/mcp/:serverId', element: <McpServerDetail /> },
      { path: '/dashboard/registry', element: <RegistrySearch /> },
      { path: '/dashboard/registry/register', element: <RegisterOrgForm /> },
      { path: '/dashboard/registry/:did', element: <RegistryOrgDetail /> },
      { path: '/dashboard/billing', element: <BillingPage /> },
      { path: '/dashboard/settings', element: <SettingsPage /> },
      { path: '/dashboard/dpdp/records', element: <ConsentRecordList /> },
      { path: '/dashboard/dpdp/records/:recordId', element: <ConsentRecordDetail /> },
      { path: '/dashboard/dpdp/grievances', element: <GrievanceList /> },
      { path: '/dashboard/dpdp/exports', element: <ExportPage /> },
      { path: '/dashboard/settings/sso', element: <SsoConfigPage /> },
      { path: '/dashboard/settings/scim', element: <ScimTokensPage /> },
      { path: '/dashboard/*', element: <NotFound /> },
    ],
  },
  { path: '*', element: <NotFound /> },
];
