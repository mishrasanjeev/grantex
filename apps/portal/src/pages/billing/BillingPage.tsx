import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getSubscription, createCheckout, getPortalUrl } from '../../api/billing';
import type { Subscription } from '../../api/types';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';

const PLANS = [
  {
    name: 'free',
    label: 'Free',
    price: '$0',
    features: ['5 agents', '100 grants', '1,000 audit entries', 'Community support'],
  },
  {
    name: 'pro',
    label: 'Pro',
    price: '$49/mo',
    features: ['50 agents', '10,000 grants', '100,000 audit entries', 'Priority support', 'SOC 2 evidence packs'],
  },
  {
    name: 'enterprise',
    label: 'Enterprise',
    price: '$249/mo',
    features: ['Unlimited agents', 'Unlimited grants', 'Unlimited audit entries', 'Dedicated support', 'All compliance packs', 'SSO & SCIM'],
  },
];

export function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const { show } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      show('Subscription activated!', 'success');
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, show]);

  useEffect(() => {
    getSubscription()
      .then(setSubscription)
      .catch(() => show('Failed to load subscription', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  async function handleCheckout(plan: string) {
    setCheckingOut(plan);
    try {
      const { checkoutUrl } = await createCheckout(plan);
      window.location.href = checkoutUrl;
    } catch {
      show('Failed to start checkout', 'error');
      setCheckingOut(null);
    }
  }

  async function handleManage() {
    setOpeningPortal(true);
    try {
      const { portalUrl } = await getPortalUrl();
      window.location.href = portalUrl;
    } catch {
      show('Failed to open billing portal', 'error');
      setOpeningPortal(false);
    }
  }

  if (loading || !subscription) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const currentPlan = subscription.plan;

  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Billing</h1>

      {/* Current plan */}
      <Card className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gx-muted mb-1">Current Plan</p>
            <div className="flex items-center gap-3">
              <p className="text-2xl font-bold text-gx-text capitalize">{currentPlan}</p>
              <Badge>{subscription.status}</Badge>
            </div>
            {subscription.currentPeriodEnd && (
              <p className="text-xs text-gx-muted mt-2">
                Current period ends {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          {currentPlan !== 'free' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleManage}
              disabled={openingPortal}
            >
              {openingPortal ? <Spinner className="h-3 w-3" /> : 'Manage Subscription'}
            </Button>
          )}
        </div>
      </Card>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          const isCurrent = plan.name === currentPlan;
          const isUpgrade = !isCurrent && plan.name !== 'free';

          return (
            <Card key={plan.name}>
              <div className="flex flex-col h-full">
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-semibold text-gx-text">{plan.label}</h3>
                    {isCurrent && <Badge>Current</Badge>}
                  </div>
                  <p className="text-2xl font-bold font-mono text-gx-accent">{plan.price}</p>
                </div>
                <ul className="space-y-2 mb-6 flex-1">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-gx-muted">
                      <span className="text-gx-accent mt-0.5">&#10003;</span>
                      {feature}
                    </li>
                  ))}
                </ul>
                {isUpgrade && (
                  <Button
                    size="sm"
                    onClick={() => handleCheckout(plan.name)}
                    disabled={checkingOut === plan.name}
                  >
                    {checkingOut === plan.name ? <Spinner className="h-3 w-3" /> : 'Upgrade'}
                  </Button>
                )}
                {isCurrent && plan.name !== 'free' && (
                  <Button variant="secondary" size="sm" disabled>
                    Current Plan
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
