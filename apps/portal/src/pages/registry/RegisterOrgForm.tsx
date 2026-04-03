import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { registerOrg } from '../../api/registry';
import type { RegisterOrgParams } from '../../api/registry';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';

type Step = 1 | 2 | 3 | 4;

const VERIFICATION_METHODS = [
  {
    id: 'dns-txt',
    label: 'DNS TXT Record',
    recommended: true,
    description: 'Add a TXT record to your domain DNS. Fastest and most reliable.',
    instructions: 'Add a TXT record at _grantex.<your-domain> with the value provided after registration.',
  },
  {
    id: 'well-known',
    label: '.well-known Endpoint',
    recommended: false,
    description: 'Host a JSON file at /.well-known/grantex-verification on your domain.',
    instructions: 'Serve a JSON file at https://<your-domain>/.well-known/grantex-verification containing your verification token.',
  },
  {
    id: 'soc2',
    label: 'SOC 2 Attestation',
    recommended: false,
    description: 'Provide a SOC 2 Type II report for automated compliance verification.',
    instructions: 'Upload your SOC 2 Type II report. Our compliance team will review it within 2 business days.',
  },
  {
    id: 'manual',
    label: 'Manual Review',
    recommended: false,
    description: 'Request a manual review by the Grantex team.',
    instructions: 'Submit your organization details for manual verification. This typically takes 3-5 business days.',
  },
];

export function RegisterOrgForm() {
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { show } = useToast();

  // Form state
  const [did, setDid] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [securityEmail, setSecurityEmail] = useState('');
  const [dpoEmail, setDpoEmail] = useState('');
  const [verificationMethod, setVerificationMethod] = useState('dns-txt');

  function canAdvance(): boolean {
    switch (step) {
      case 1:
        return did.trim().length > 0 && name.trim().length > 0;
      case 2:
        return securityEmail.trim().length > 0 && securityEmail.includes('@');
      case 3:
        return verificationMethod.length > 0;
      case 4:
        return true;
      default:
        return false;
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const params: RegisterOrgParams = {
        did: did.trim(),
        name: name.trim(),
        contact: {
          security: securityEmail.trim(),
          ...(dpoEmail.trim() ? { dpo: dpoEmail.trim() } : {}),
        },
        requestVerification: true,
        verificationMethod,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(website.trim() ? { website: website.trim() } : {}),
      };
      await registerOrg(params);
      show('Organization registered successfully', 'success');
      navigate('/dashboard/registry');
    } catch {
      show('Failed to register organization', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedMethod = VERIFICATION_METHODS.find((m) => m.id === verificationMethod);

  return (
    <div className="max-w-2xl mx-auto">
      <Link to="/dashboard/registry" className="text-sm text-gx-muted hover:text-gx-text mb-4 inline-flex items-center gap-1">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Registry
      </Link>

      <h1 className="text-xl font-semibold text-gx-text mb-2 mt-4">Register Your Organization</h1>
      <p className="text-sm text-gx-muted mb-6">
        Add your organization to the Grantex Trust Registry so developers can discover and verify your agents.
      </p>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {([1, 2, 3, 4] as Step[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => s < step ? setStep(s) : undefined}
              className={`w-8 h-8 rounded-full text-xs font-semibold flex items-center justify-center transition-colors ${
                s === step
                  ? 'bg-gx-accent text-gx-bg'
                  : s < step
                    ? 'bg-gx-accent/20 text-gx-accent cursor-pointer'
                    : 'bg-gx-border/50 text-gx-muted'
              }`}
            >
              {s < step ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                s
              )}
            </button>
            {s < 4 && (
              <div className={`w-12 h-0.5 ${s < step ? 'bg-gx-accent/40' : 'bg-gx-border/50'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Organization Details */}
      {step === 1 && (
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Organization Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                DID <span className="text-gx-danger">*</span>
              </label>
              <input
                type="text"
                value={did}
                onChange={(e) => setDid(e.target.value)}
                placeholder="did:web:your-domain.com"
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
              />
              <p className="text-xs text-gx-muted mt-1">
                Your organization's Decentralized Identifier. We recommend did:web for most organizations.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                Organization Name <span className="text-gx-danger">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corp"
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of your organization..."
                rows={3}
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30 resize-vertical"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                Website
              </label>
              <input
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://your-domain.com"
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
              />
            </div>
          </div>
          <div className="flex justify-end mt-6">
            <Button size="sm" onClick={() => setStep(2)} disabled={!canAdvance()}>
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* Step 2: Contact Info */}
      {step === 2 && (
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Contact Information</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                Security Contact Email <span className="text-gx-danger">*</span>
              </label>
              <input
                type="email"
                value={securityEmail}
                onChange={(e) => setSecurityEmail(e.target.value)}
                placeholder="security@your-domain.com"
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
              />
              <p className="text-xs text-gx-muted mt-1">
                Public security contact for vulnerability disclosures and trust inquiries.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gx-muted mb-1.5">
                Data Protection Officer Email
              </label>
              <input
                type="email"
                value={dpoEmail}
                onChange={(e) => setDpoEmail(e.target.value)}
                placeholder="dpo@your-domain.com"
                className="w-full px-3 py-2 text-sm bg-gx-bg border border-gx-border rounded-md text-gx-text placeholder:text-gx-muted/50 focus:outline-none focus:border-gx-accent focus:ring-1 focus:ring-gx-accent/30"
              />
              <p className="text-xs text-gx-muted mt-1">
                Required for GDPR and DPDP compliance badges.
              </p>
            </div>
          </div>
          <div className="flex justify-between mt-6">
            <Button variant="secondary" size="sm" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button size="sm" onClick={() => setStep(3)} disabled={!canAdvance()}>
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* Step 3: Verification Method */}
      {step === 3 && (
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Verification Method</h2>
          <p className="text-sm text-gx-muted mb-4">
            Choose how you'd like to verify ownership of your DID.
          </p>
          <div className="space-y-3">
            {VERIFICATION_METHODS.map((method) => (
              <label
                key={method.id}
                className={`block p-4 rounded-lg border cursor-pointer transition-colors ${
                  verificationMethod === method.id
                    ? 'border-gx-accent bg-gx-accent/5'
                    : 'border-gx-border hover:border-gx-muted'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="verification"
                    value={method.id}
                    checked={verificationMethod === method.id}
                    onChange={() => setVerificationMethod(method.id)}
                    className="mt-1 accent-gx-accent"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gx-text">{method.label}</span>
                      {method.recommended && (
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-gx-accent/10 text-gx-accent">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gx-muted mt-1">{method.description}</p>
                  </div>
                </div>
              </label>
            ))}
          </div>

          {/* Instructions for selected method */}
          {selectedMethod && (
            <div className="mt-4 p-3 bg-gx-bg border border-gx-border rounded-md">
              <p className="text-xs font-medium text-gx-accent mb-1">Instructions</p>
              <p className="text-xs text-gx-muted">{selectedMethod.instructions}</p>
            </div>
          )}

          <div className="flex justify-between mt-6">
            <Button variant="secondary" size="sm" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button size="sm" onClick={() => setStep(4)} disabled={!canAdvance()}>
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* Step 4: Review & Submit */}
      {step === 4 && (
        <Card>
          <h2 className="text-sm font-semibold text-gx-text mb-4">Review & Submit</h2>
          <div className="space-y-4">
            <ReviewField label="DID" value={did} />
            <ReviewField label="Organization Name" value={name} />
            {description && <ReviewField label="Description" value={description} />}
            {website && <ReviewField label="Website" value={website} />}
            <ReviewField label="Security Contact" value={securityEmail} />
            {dpoEmail && <ReviewField label="DPO Email" value={dpoEmail} />}
            <ReviewField
              label="Verification Method"
              value={VERIFICATION_METHODS.find((m) => m.id === verificationMethod)?.label ?? verificationMethod}
            />
          </div>
          <div className="flex justify-between mt-6">
            <Button variant="secondary" size="sm" onClick={() => setStep(3)}>
              Back
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Registering...' : 'Register Organization'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function ReviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-gx-border/50 last:border-0">
      <span className="text-xs text-gx-muted w-36 flex-shrink-0">{label}</span>
      <span className="text-sm text-gx-text break-all">{value}</span>
    </div>
  );
}
