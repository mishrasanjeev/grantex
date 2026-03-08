import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';

export function WebAuthnList() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">WebAuthn</h1>

      <Card className="p-0">
        <EmptyState
          title="No WebAuthn credentials"
          description="Register a passkey or security key to enable passwordless authentication."
        />
      </Card>
    </div>
  );
}
