import { useState } from 'react';
import { createEnrollmentSession, deleteWebAuthnCredential, listWebAuthnCredentials,
  type WebAuthnCredential, type EnrollmentSession } from '../../api/webauthn';
import { useToast } from '../../store/toast';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';

export function WebAuthnList() {
  const [principalId, setPrincipalId] = useState('');
  const [authRequestId, setAuthRequestId] = useState('');
  const [session, setSession] = useState<EnrollmentSession | null>(null);
  const [credentials, setCredentials] = useState<WebAuthnCredential[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WebAuthnCredential | null>(null);
  const { show } = useToast();

  async function loadCredentials() {
    if (!principalId.trim()) return;
    setBusy(true);
    try {
      setCredentials(await listWebAuthnCredentials(principalId.trim()));
    } catch {
      show('Could not load passkeys', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createLink() {
    if (!principalId.trim()) return;
    setBusy(true);
    setSession(null);
    try {
      setSession(await createEnrollmentSession(principalId.trim(), authRequestId.trim() || undefined));
    } catch {
      show('Could not issue enrollment link', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteWebAuthnCredential(deleteTarget.id);
      setCredentials((current) => current?.filter((item) => item.id !== deleteTarget.id) ?? null);
      setDeleteTarget(null);
      show('Passkey removed', 'success');
    } catch {
      show('Could not remove passkey', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gx-text">Passkeys</h1>
      <section className="border-y border-gx-border py-5 space-y-4" aria-labelledby="enroll-heading">
        <h2 id="enroll-heading" className="text-sm font-semibold text-gx-text">Customer enrollment</h2>
        <p className="text-sm text-gx-muted">Issue the link only after authenticating the customer in your application. It expires in ten minutes and works once.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-gx-text">Principal ID
            <input className="mt-1 block w-full bg-gx-surface border border-gx-border rounded-md px-3 py-2"
              value={principalId} maxLength={256} onChange={(event) => {
                setPrincipalId(event.target.value); setSession(null); setCredentials(null);
              }} />
          </label>
          <label className="text-sm text-gx-text">Authorization request ID (optional)
            <input className="mt-1 block w-full bg-gx-surface border border-gx-border rounded-md px-3 py-2"
              value={authRequestId} onChange={(event) => { setAuthRequestId(event.target.value); setSession(null); }} />
          </label>
        </div>
        <div className="flex gap-2">
          <Button onClick={createLink} disabled={busy || !principalId.trim()}>Create enrollment link</Button>
          <Button variant="secondary" onClick={loadCredentials} disabled={busy || !principalId.trim()}>View passkeys</Button>
        </div>
        {session && (
          <div className="space-y-2 max-w-2xl">
            <label className="text-sm text-gx-text block">One-use enrollment link
              <input className="mt-1 w-full bg-gx-surface border border-gx-border rounded-md px-3 py-2 font-mono text-xs"
                readOnly value={session.enrollmentUrl} onFocus={(event) => event.target.select()} />
            </label>
            <p className="text-xs text-gx-muted">Expires {new Date(session.expiresAt).toLocaleString()}. Treat this link as a secret.</p>
            <Button variant="secondary" size="sm" onClick={async () => {
              try { await navigator.clipboard.writeText(session.enrollmentUrl); show('Link copied', 'success'); }
              catch { show('Could not copy link', 'error'); }
            }}>Copy link</Button>
          </div>
        )}
      </section>
      <section aria-labelledby="credentials-heading">
        <h2 id="credentials-heading" className="text-sm font-semibold text-gx-text mb-3">Registered passkeys</h2>
        {credentials?.length === 0 && <EmptyState title="No passkeys" description="No passkeys are registered for this principal." />}
        {credentials && credentials.length > 0 && (
          <ul className="divide-y divide-gx-border border-y border-gx-border">
            {credentials.map((credential) => (
              <li key={credential.id} className="flex justify-between items-center gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-gx-text">{credential.deviceName || 'Passkey'}</p>
                  <p className="text-xs text-gx-muted">Added {new Date(credential.createdAt).toLocaleDateString()}</p>
                </div>
                <Button variant="danger" size="sm" onClick={() => setDeleteTarget(credential)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}
        onConfirm={removeCredential} loading={busy} title="Remove passkey"
        message="This passkey will no longer approve requests for this principal." confirmLabel="Remove" />
    </div>
  );
}
