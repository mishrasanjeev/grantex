import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';

export function CredentialList() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Credentials</h1>

      <Card className="p-0">
        <EmptyState
          title="No credentials"
          description="Create API credentials to authenticate with the Grantex API."
        />
      </Card>
    </div>
  );
}
