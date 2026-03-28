/**
 * x402 Weather API — Express server with x402 pricing + GDT enforcement.
 *
 * Demonstrates:
 * 1. x402 payment flow (402 → pay → retry)
 * 2. GDT verification via x402Middleware
 * 3. Audit log of all authorization events
 *
 * Start: npm start
 * Port: 3402
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  generateKeyPair,
  issueGDT,
  x402Middleware,
  HEADERS,
  getAuditLog,
} from '@grantex/x402';

const app = express();
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

const PORT = 3402;
const PRICE = 0.001; // $0.001 USDC per request
const RECIPIENT = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18'; // mock wallet

// ── Generate demo keys ─────────────────────────────────────────────
const principal = generateKeyPair();
const agent = generateKeyPair();

// ── x402 Payment Gate ──────────────────────────────────────────────
// Returns 402 if no payment proof, passes through if paid
function x402PaymentGate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const paymentProof = req.get(HEADERS.PAYMENT_PROOF);

  if (!paymentProof) {
    // Return 402 Payment Required with payment details
    res
      .status(402)
      .set(HEADERS.PAYMENT_AMOUNT, String(PRICE))
      .set(HEADERS.PAYMENT_CURRENCY, 'USDC')
      .set(HEADERS.PAYMENT_RECIPIENT, RECIPIENT)
      .set(HEADERS.PAYMENT_CHAIN, 'base')
      .json({
        error: 'PAYMENT_REQUIRED',
        message: `This endpoint requires a payment of ${PRICE} USDC on Base L2.`,
        amount: PRICE,
        currency: 'USDC',
        recipientAddress: RECIPIENT,
        chain: 'base',
      });
    return;
  }

  // Payment proof present — validate it (mock validation)
  try {
    const decoded = JSON.parse(
      Buffer.from(paymentProof, 'base64url').toString(),
    );
    if (decoded.amount < PRICE) {
      res.status(402).json({ error: 'INSUFFICIENT_PAYMENT' });
      return;
    }
    (req as Record<string, unknown>)['payment'] = decoded;
    next();
  } catch {
    // Accept any non-empty proof in demo mode
    next();
  }
}

// ── GDT Verification Middleware ────────────────────────────────────
const gdtMiddleware = x402Middleware({
  requiredScopes: ['weather:read'],
  currency: 'USDC',
  extractAmount: () => PRICE,
});

// ── Routes ─────────────────────────────────────────────────────────

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'x402-weather-api' });
});

// Service status (no auth required)
app.get('/api/weather/status', (_req, res) => {
  res.json({
    service: 'weather-api',
    status: 'operational',
    pricing: { amount: PRICE, currency: 'USDC', chain: 'base' },
    gdtRequired: true,
  });
});

// Weather forecast (x402 + GDT required)
app.get(
  '/api/weather/forecast',
  x402PaymentGate,
  gdtMiddleware as express.RequestHandler,
  (req, res) => {
    const gdt = (req as Record<string, unknown>)['gdt'] as Record<string, unknown>;
    res.json({
      forecast: {
        location: 'San Francisco, CA',
        temperature: 68,
        unit: 'F',
        condition: 'Partly Cloudy',
        humidity: 72,
        wind: { speed: 12, direction: 'W', unit: 'mph' },
        high: 72,
        low: 58,
        precipitation: '10%',
      },
      authorization: {
        agentDID: gdt?.['agentDID'],
        principalDID: gdt?.['principalDID'],
        scopes: gdt?.['scopes'],
        remainingLimit: gdt?.['remainingLimit'],
      },
      pricing: {
        charged: PRICE,
        currency: 'USDC',
        chain: 'base',
      },
    });
  },
);

// Audit log (no auth)
app.get('/api/audit', async (_req, res) => {
  const log = getAuditLog();
  const entries = await log.export();
  res.json({ entries });
});

// ── Start ──────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Issue a sample GDT for testing
  const gdt = await issueGDT({
    agentDID: agent.did,
    scope: ['weather:read'],
    spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
    expiry: '24h',
    signingKey: principal.privateKey,
  });

  app.listen(PORT, () => {
    console.log(`\n🌤️  x402 Weather API running on http://localhost:${PORT}\n`);
    console.log('─── Demo Identities ───');
    console.log(`Principal DID: ${principal.did}`);
    console.log(`Agent DID:     ${agent.did}`);
    console.log(`\n─── Sample GDT ───`);
    console.log(gdt);
    console.log(`\n─── Test Commands ───`);
    console.log(`\n# Check status (no auth):`);
    console.log(`curl http://localhost:${PORT}/api/weather/status`);
    console.log(`\n# Trigger 402 (no payment, no GDT):`);
    console.log(`curl http://localhost:${PORT}/api/weather/forecast`);
    console.log(`\n# Full flow with payment + GDT:`);
    console.log(`curl http://localhost:${PORT}/api/weather/forecast \\`);
    console.log(`  -H "X-Grantex-GDT: ${gdt.slice(0, 50)}..." \\`);
    console.log(`  -H "X-Payment-Proof: $(echo '{"amount":0.001,"chain":"base"}' | base64)" \\`);
    console.log(`  -H "X-Payment-Amount: 0.001"`);
    console.log('');
  });
}

start().catch(console.error);
