import type { BadgeVariant } from '../../components/ui/Badge';
import type { ConsentRecordStatus, GrievanceStatus } from '../../api/dpdp';

/** Badge variant for every consent record status the server produces. */
export function consentStatusVariant(status: ConsentRecordStatus | string): BadgeVariant {
  switch (status) {
    case 'active': return 'success';
    case 'withdrawn': return 'warning';
    case 'erased': return 'danger';
    case 'expired':
    default: return 'default';
  }
}

/** Badge variant for every grievance status the server produces. */
export function grievanceStatusVariant(status: GrievanceStatus | string): BadgeVariant {
  switch (status) {
    case 'submitted': return 'warning';
    case 'in_review': return 'info';
    case 'resolved': return 'success';
    case 'rejected': return 'danger';
    default: return 'default';
  }
}

export function grievanceStatusLabel(status: GrievanceStatus | string): string {
  return status.replace(/_/g, ' ');
}

/** An open grievance is past its published response deadline. */
export function isGrievanceOverdue(g: { status: string; expectedResolutionBy: string }, now = Date.now()): boolean {
  if (g.status !== 'submitted' && g.status !== 'in_review') return false;
  const due = Date.parse(g.expectedResolutionBy);
  return Number.isFinite(due) && due < now;
}
