import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { newSubscriptionId } from '../lib/ids.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { getStripe } from '../lib/stripe.js';

type PlanParam = 'pro' | 'enterprise';

interface CheckoutBody {
  plan: PlanParam;
  successUrl: string;
  cancelUrl: string;
}

interface PortalBody {
  returnUrl: string;
}

interface StripeWebhookBody extends Buffer {}

function requireStripe(reply: Parameters<FastifyInstance['post']>[1] extends infer R ? never : never) {
  // dummy — see usage in handlers
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ----------------------------------------------------------------
  // POST /v1/billing/webhook (Stripe → us)
  // Must be in its own child scope so we can install a raw-body
  // content-type parser without affecting the other billing routes.
  // ----------------------------------------------------------------
  await app.register(async (webhookApp: FastifyInstance) => {
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body as Buffer);
      },
    );

    webhookApp.post<{ Body: Buffer }>(
      '/v1/billing/webhook',
      { config: { skipAuth: true } },
      async (request, reply) => {
        const stripeWebhookSecret = config.stripeWebhookSecret;
        if (!stripeWebhookSecret) {
          return reply.status(503).send({ message: 'Billing not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
        }

        let stripe: ReturnType<typeof getStripe>;
        try {
          stripe = getStripe();
        } catch {
          return reply.status(503).send({ message: 'Billing not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
        }

        const sig = request.headers['stripe-signature'];
        if (!sig || typeof sig !== 'string') {
          return reply.status(400).send({ message: 'Missing stripe-signature header', code: 'BAD_REQUEST', requestId: request.id });
        }

        let event: ReturnType<typeof stripe.webhooks.constructEvent>;
        try {
          event = stripe.webhooks.constructEvent(request.body, sig, stripeWebhookSecret);
        } catch {
          return reply.status(400).send({ message: 'Invalid webhook signature', code: 'BAD_REQUEST', requestId: request.id });
        }

        const sql = getSql();

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as {
            customer: string;
            subscription: string;
            metadata: { developerId?: string; plan?: string };
          };
          const { developerId, plan } = session.metadata;
          if (!developerId || !plan || !isPlanName(plan)) return reply.send({ received: true });

          await sql`
            INSERT INTO subscriptions (id, developer_id, stripe_customer_id, stripe_subscription_id, plan, status)
            VALUES (${newSubscriptionId()}, ${developerId}, ${session.customer}, ${session.subscription}, ${plan}, 'active')
            ON CONFLICT (developer_id) DO UPDATE SET
              stripe_customer_id     = EXCLUDED.stripe_customer_id,
              stripe_subscription_id = EXCLUDED.stripe_subscription_id,
              plan                   = EXCLUDED.plan,
              status                 = 'active',
              updated_at             = now()
          `;
        } else if (event.type === 'customer.subscription.updated') {
          const sub = event.data.object as unknown as {
            id: string;
            customer: string;
            status: string;
            current_period_end: number;
            items: { data: Array<{ price: { id: string } }> };
          };
          const priceId = sub.items.data[0]?.price.id ?? '';
          let plan: string = 'free';
          if (priceId === config.stripePricePro) plan = 'pro';
          else if (priceId === config.stripePriceEnterprise) plan = 'enterprise';

          await sql`
            UPDATE subscriptions SET
              plan               = ${plan},
              status             = ${sub.status},
              current_period_end = to_timestamp(${sub.current_period_end}),
              updated_at         = now()
            WHERE stripe_subscription_id = ${sub.id}
          `;
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object as { id: string };
          await sql`
            UPDATE subscriptions SET plan = 'free', status = 'canceled', updated_at = now()
            WHERE stripe_subscription_id = ${sub.id}
          `;
        } else if (event.type === 'invoice.payment_failed') {
          const inv = event.data.object as unknown as { subscription: string };
          await sql`
            UPDATE subscriptions SET status = 'past_due', updated_at = now()
            WHERE stripe_subscription_id = ${inv.subscription}
          `;
        }

        return reply.send({ received: true });
      },
    );
  });

  // ----------------------------------------------------------------
  // GET /v1/billing/subscription
  // ----------------------------------------------------------------
  app.get('/v1/billing/subscription', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<{ plan: string; status: string; current_period_end: string | null }[]>`
      SELECT plan, status, current_period_end
      FROM subscriptions
      WHERE developer_id = ${request.developer.id}
    `;
    const row = rows[0];
    return reply.send({
      plan: row?.plan ?? 'free',
      status: row?.status ?? 'active',
      currentPeriodEnd: row?.current_period_end ?? null,
    });
  });

  // ----------------------------------------------------------------
  // POST /v1/billing/checkout
  // ----------------------------------------------------------------
  app.post<{ Body: CheckoutBody }>('/v1/billing/checkout', async (request, reply) => {
    const { plan, successUrl, cancelUrl } = request.body;

    if (!plan || !['pro', 'enterprise'].includes(plan)) {
      return reply.status(400).send({ message: "plan must be 'pro' or 'enterprise'", code: 'BAD_REQUEST', requestId: request.id });
    }
    if (!successUrl || !cancelUrl) {
      return reply.status(400).send({ message: 'successUrl and cancelUrl are required', code: 'BAD_REQUEST', requestId: request.id });
    }

    const priceId = plan === 'pro' ? config.stripePricePro : config.stripePriceEnterprise;

    let stripe: ReturnType<typeof getStripe>;
    try {
      stripe = getStripe();
    } catch {
      return reply.status(503).send({ message: 'Billing not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
    }

    if (!priceId) {
      return reply.status(503).send({ message: 'Billing not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { developerId: request.developer.id, plan },
    });

    return reply.status(201).send({ checkoutUrl: session.url });
  });

  // ----------------------------------------------------------------
  // POST /v1/billing/portal
  // ----------------------------------------------------------------
  app.post<{ Body: PortalBody }>('/v1/billing/portal', async (request, reply) => {
    const { returnUrl } = request.body;
    if (!returnUrl) {
      return reply.status(400).send({ message: 'returnUrl is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const rows = await sql<{ stripe_customer_id: string | null }[]>`
      SELECT stripe_customer_id FROM subscriptions WHERE developer_id = ${request.developer.id}
    `;
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      return reply.status(400).send({ message: 'No active subscription found. Complete a checkout first.', code: 'BAD_REQUEST', requestId: request.id });
    }

    let stripe: ReturnType<typeof getStripe>;
    try {
      stripe = getStripe();
    } catch {
      return reply.status(503).send({ message: 'Billing not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return reply.status(201).send({ portalUrl: session.url });
  });
}
