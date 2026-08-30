/** Official x402 v2 resource-server example backed by Grantex prepaid wallets. */

import express from 'express';
import type { Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { HEADERS } from '@grantex/x402';

const app = express();
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));

const PORT = Number(process.env['PORT'] ?? 3402);
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const FACILITATOR_URL = (process.env['GRANTEX_FACILITATOR_URL'] ?? 'http://localhost:3001/v1/x402').replace(/\/$/, '');
const RESOURCE_URL = `${PUBLIC_URL}/api/weather/forecast`;

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'grantex:prepaid',
  amount: '1000', // 0.001 USDC when the wallet uses six decimals
  asset: 'USDC',
  payTo: 'merchant:weather-api',
  maxTimeoutSeconds: 120,
  extra: { grantexScope: 'weather:read' },
};

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: RESOURCE_URL,
    description: 'Current weather forecast',
    mimeType: 'application/json',
  },
  accepts: [requirements],
};

function sendPaymentRequired(response: Response, error: string, detail?: unknown): void {
  response
    .status(402)
    .set(HEADERS.PAYMENT_REQUIRED, encodePaymentRequiredHeader(paymentRequired))
    .set('Cache-Control', 'no-store')
    .json({ error, ...(detail !== undefined ? { detail } : {}) });
}

async function facilitator(path: 'verify' | 'settle', paymentPayload: PaymentPayload) {
  const response = await fetch(`${FACILITATOR_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements: requirements,
    }),
  });
  if (!response.ok) throw new Error(`Facilitator ${path} returned HTTP ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'x402-weather-api' });
});

app.get('/api/weather/status', (_request, response) => {
  response.json({
    service: 'weather-api',
    status: 'operational',
    x402Version: 2,
    pricing: requirements,
    facilitator: FACILITATOR_URL,
  });
});

app.get('/api/weather/forecast', async (request, response) => {
  const signature = request.get(HEADERS.PAYMENT_SIGNATURE);
  if (!signature) {
    sendPaymentRequired(response, 'PAYMENT_REQUIRED');
    return;
  }

  try {
    const payload = decodePaymentSignatureHeader(signature);
    const verification = await facilitator('verify', payload);
    if (verification['isValid'] !== true) {
      sendPaymentRequired(response, 'PAYMENT_INVALID', verification['invalidReason']);
      return;
    }

    const settlement = await facilitator('settle', payload);
    if (settlement['success'] !== true) {
      response.set(HEADERS.PAYMENT_RESPONSE, encodePaymentResponseHeader(settlement as never));
      sendPaymentRequired(response, 'PAYMENT_FAILED', settlement['errorReason']);
      return;
    }

    response
      .set(HEADERS.PAYMENT_RESPONSE, encodePaymentResponseHeader(settlement as never))
      .set('Cache-Control', 'private, no-store')
      .json({
        forecast: {
          location: 'San Francisco, CA',
          temperature: 68,
          unit: 'F',
          condition: 'Partly Cloudy',
          humidity: 72,
          wind: { speed: 12, direction: 'W', unit: 'mph' },
        },
        payment: {
          transaction: settlement['transaction'],
          network: settlement['network'],
          payer: settlement['payer'],
          amount: requirements.amount,
          asset: requirements.asset,
        },
      });
  } catch (error) {
    sendPaymentRequired(
      response,
      'PAYMENT_INVALID',
      error instanceof Error ? error.message : 'Invalid payment signature',
    );
  }
});

app.listen(PORT, () => {
  console.log(`x402 Weather API listening at ${PUBLIC_URL}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
});
