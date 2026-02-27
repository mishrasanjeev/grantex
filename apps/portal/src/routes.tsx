import { Navigate, type RouteObject } from 'react-router-dom';
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
import { RequireAuth } from './RequireAuth';

// Placeholder pages for future PRs
function Placeholder({ title }: { title: string }) {
  return (
    <div className="py-8">
      <h1 className="text-xl font-semibold text-gx-text mb-2">{title}</h1>
      <p className="text-sm text-gx-muted">Coming soon.</p>
    </div>
  );
}

export const routes: RouteObject[] = [
  { path: '/dashboard/login', element: <Login /> },
  { path: '/dashboard/signup', element: <Signup /> },
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
      { path: '/dashboard/audit', element: <AuditLog /> },
      { path: '/dashboard/audit/:id', element: <AuditDetail /> },
      { path: '/dashboard/policies', element: <PolicyList /> },
      { path: '/dashboard/policies/new', element: <PolicyForm /> },
      { path: '/dashboard/policies/:id/edit', element: <PolicyForm /> },
      { path: '/dashboard/anomalies', element: <AnomalyList /> },
      { path: '/dashboard/compliance', element: <Placeholder title="Compliance" /> },
      { path: '/dashboard/billing', element: <Placeholder title="Billing" /> },
      { path: '/dashboard/settings', element: <Placeholder title="Settings" /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard/login" replace /> },
];
