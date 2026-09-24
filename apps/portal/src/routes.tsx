import { lazy } from 'react';
import { type RouteObject } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { RequireAuth } from './RequireAuth';

const Login = lazy(() => import('./pages/Login').then(({ Login }) => ({ default: Login })));
const Signup = lazy(() => import('./pages/Signup').then(({ Signup }) => ({ default: Signup })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(({ Dashboard }) => ({ default: Dashboard })));
const AgentList = lazy(() => import('./pages/agents/AgentList').then(({ AgentList }) => ({ default: AgentList })));
const AgentForm = lazy(() => import('./pages/agents/AgentForm').then(({ AgentForm }) => ({ default: AgentForm })));
const AgentDetail = lazy(() => import('./pages/agents/AgentDetail').then(({ AgentDetail }) => ({ default: AgentDetail })));
const GrantList = lazy(() => import('./pages/grants/GrantList').then(({ GrantList }) => ({ default: GrantList })));
const GrantDetail = lazy(() => import('./pages/grants/GrantDetail').then(({ GrantDetail }) => ({ default: GrantDetail })));
const AuditLog = lazy(() => import('./pages/audit/AuditLog').then(({ AuditLog }) => ({ default: AuditLog })));
const AuditDetail = lazy(() => import('./pages/audit/AuditDetail').then(({ AuditDetail }) => ({ default: AuditDetail })));
const PolicyList = lazy(() => import('./pages/policies/PolicyList').then(({ PolicyList }) => ({ default: PolicyList })));
const PolicyForm = lazy(() => import('./pages/policies/PolicyForm').then(({ PolicyForm }) => ({ default: PolicyForm })));
const AnomalyList = lazy(() => import('./pages/anomalies/AnomalyList').then(({ AnomalyList }) => ({ default: AnomalyList })));
const AlertDetail = lazy(() => import('./pages/anomalies/AlertDetail').then(({ AlertDetail }) => ({ default: AlertDetail })));
const RuleBuilder = lazy(() => import('./pages/anomalies/RuleBuilder').then(({ RuleBuilder }) => ({ default: RuleBuilder })));
const ComplianceDashboard = lazy(() => import('./pages/compliance/ComplianceDashboard').then(({ ComplianceDashboard }) => ({ default: ComplianceDashboard })));
const BillingPage = lazy(() => import('./pages/billing/BillingPage').then(({ BillingPage }) => ({ default: BillingPage })));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })));
const SsoConfigPage = lazy(() => import('./pages/settings/SsoConfigPage').then(({ SsoConfigPage }) => ({ default: SsoConfigPage })));
const ScimTokensPage = lazy(() => import('./pages/settings/ScimTokensPage').then(({ ScimTokensPage }) => ({ default: ScimTokensPage })));
const WebhookList = lazy(() => import('./pages/webhooks/WebhookList').then(({ WebhookList }) => ({ default: WebhookList })));
const WebhookDeliveries = lazy(() => import('./pages/webhooks/WebhookDeliveries').then(({ WebhookDeliveries }) => ({ default: WebhookDeliveries })));
const BudgetList = lazy(() => import('./pages/budgets/BudgetList').then(({ BudgetList }) => ({ default: BudgetList })));
const BudgetDetail = lazy(() => import('./pages/budgets/BudgetDetail').then(({ BudgetDetail }) => ({ default: BudgetDetail })));
const UsageDashboard = lazy(() => import('./pages/usage/UsageDashboard').then(({ UsageDashboard }) => ({ default: UsageDashboard })));
const DomainList = lazy(() => import('./pages/domains/DomainList').then(({ DomainList }) => ({ default: DomainList })));
const WebAuthnList = lazy(() => import('./pages/webauthn/WebAuthnList').then(({ WebAuthnList }) => ({ default: WebAuthnList })));
const CredentialList = lazy(() => import('./pages/credentials/CredentialList').then(({ CredentialList }) => ({ default: CredentialList })));
const EventList = lazy(() => import('./pages/events/EventList').then(({ EventList }) => ({ default: EventList })));
const BundleList = lazy(() => import('./pages/bundles/BundleList').then(({ BundleList }) => ({ default: BundleList })));
const BundleForm = lazy(() => import('./pages/bundles/BundleForm').then(({ BundleForm }) => ({ default: BundleForm })));
const BundleDetail = lazy(() => import('./pages/bundles/BundleDetail').then(({ BundleDetail }) => ({ default: BundleDetail })));
const McpServerList = lazy(() => import('./pages/mcp/McpServerList').then(({ McpServerList }) => ({ default: McpServerList })));
const McpServerForm = lazy(() => import('./pages/mcp/McpServerForm').then(({ McpServerForm }) => ({ default: McpServerForm })));
const McpServerDetail = lazy(() => import('./pages/mcp/McpServerDetail').then(({ McpServerDetail }) => ({ default: McpServerDetail })));
const CommerceOnboarding = lazy(() => import('./pages/commerce/CommerceOnboarding').then(({ CommerceOnboarding }) => ({ default: CommerceOnboarding })));
const CommerceCatalog = lazy(() => import('./pages/commerce/CommerceCatalog').then(({ CommerceCatalog }) => ({ default: CommerceCatalog })));
const CommerceWebhooks = lazy(() => import('./pages/commerce/CommerceWebhooks').then(({ CommerceWebhooks }) => ({ default: CommerceWebhooks })));
const CommercePayments = lazy(() => import('./pages/commerce/CommercePayments').then(({ CommercePayments }) => ({ default: CommercePayments })));
const CommerceAudit = lazy(() => import('./pages/commerce/CommerceAudit').then(({ CommerceAudit }) => ({ default: CommerceAudit })));
const CommercePassports = lazy(() => import('./pages/commerce/CommercePassports').then(({ CommercePassports }) => ({ default: CommercePassports })));
const CommerceSettings = lazy(() => import('./pages/commerce/CommerceSettings').then(({ CommerceSettings }) => ({ default: CommerceSettings })));
const CommercePlayground = lazy(() => import('./pages/commerce/CommercePlayground').then(({ CommercePlayground }) => ({ default: CommercePlayground })));
const CommerceOps = lazy(() => import('./pages/commerce/CommerceOps').then(({ CommerceOps }) => ({ default: CommerceOps })));
const RegistrySearch = lazy(() => import('./pages/registry/RegistrySearch').then(({ RegistrySearch }) => ({ default: RegistrySearch })));
const RegistryOrgDetail = lazy(() => import('./pages/registry/RegistryOrgDetail').then(({ RegistryOrgDetail }) => ({ default: RegistryOrgDetail })));
const RegisterOrgForm = lazy(() => import('./pages/registry/RegisterOrgForm').then(({ RegisterOrgForm }) => ({ default: RegisterOrgForm })));
const AdminPage = lazy(() => import('./pages/admin/AdminPage').then(({ AdminPage }) => ({ default: AdminPage })));
const ConsentRecordList = lazy(() => import('./pages/dpdp/ConsentRecordList').then(({ ConsentRecordList }) => ({ default: ConsentRecordList })));
const ConsentRecordDetail = lazy(() => import('./pages/dpdp/ConsentRecordDetail').then(({ ConsentRecordDetail }) => ({ default: ConsentRecordDetail })));
const GrievanceList = lazy(() => import('./pages/dpdp/GrievanceList').then(({ GrievanceList }) => ({ default: GrievanceList })));
const ExportPage = lazy(() => import('./pages/dpdp/ExportPage').then(({ ExportPage }) => ({ default: ExportPage })));
const ManifestViewer = lazy(() => import('./pages/manifests/ManifestViewer').then(({ ManifestViewer }) => ({ default: ManifestViewer })));
const EnforceLog = lazy(() => import('./pages/enforce/EnforceLog').then(({ EnforceLog }) => ({ default: EnforceLog })));
const NotFound = lazy(() => import('./pages/NotFound').then(({ NotFound }) => ({ default: NotFound })));

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
      { path: '/dashboard/anomalies/rules', element: <RuleBuilder /> },
      { path: '/dashboard/anomalies/:alertId', element: <AlertDetail /> },
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
      { path: '/dashboard/commerce/onboarding', element: <CommerceOnboarding /> },
      { path: '/dashboard/commerce/catalog', element: <CommerceCatalog /> },
      { path: '/dashboard/commerce/webhooks', element: <CommerceWebhooks /> },
      { path: '/dashboard/commerce/payments', element: <CommercePayments /> },
      { path: '/dashboard/commerce/audit', element: <CommerceAudit /> },
      { path: '/dashboard/commerce/passports', element: <CommercePassports /> },
      { path: '/dashboard/commerce/settings', element: <CommerceSettings /> },
      { path: '/dashboard/commerce/playground', element: <CommercePlayground /> },
      { path: '/dashboard/commerce/ops', element: <CommerceOps /> },
      { path: '/dashboard/registry', element: <RegistrySearch /> },
      { path: '/dashboard/registry/register', element: <RegisterOrgForm /> },
      { path: '/dashboard/registry/:did', element: <RegistryOrgDetail /> },
      { path: '/dashboard/billing', element: <BillingPage /> },
      { path: '/dashboard/settings', element: <SettingsPage /> },
      { path: '/dashboard/dpdp/records', element: <ConsentRecordList /> },
      { path: '/dashboard/dpdp/records/:recordId', element: <ConsentRecordDetail /> },
      { path: '/dashboard/dpdp/grievances', element: <GrievanceList /> },
      { path: '/dashboard/dpdp/exports', element: <ExportPage /> },
      { path: '/dashboard/manifests', element: <ManifestViewer /> },
      { path: '/dashboard/enforce-log', element: <EnforceLog /> },
      { path: '/dashboard/settings/sso', element: <SsoConfigPage /> },
      { path: '/dashboard/settings/scim', element: <ScimTokensPage /> },
      { path: '/dashboard/*', element: <NotFound /> },
    ],
  },
  { path: '*', element: <NotFound /> },
];
