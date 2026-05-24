import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPassport, PassportVerificationError } from '@grantex/mpp';
import type { VerifiedPassport } from '@grantex/mpp';

const app = express();
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// CORS — explicit allowlist, not wildcard.
//
// Origins come from MPP_DEMO_CORS_ALLOWED_ORIGINS (comma-separated). When
// the env var is unset we fall back to the local dev origins the demo UI
// is served from. Production deployments must set the env var explicitly;
// anything not in the list is rejected at the preflight stage.
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  (process.env['MPP_DEMO_CORS_ALLOWED_ORIGINS'] ?? DEFAULT_DEV_ORIGINS.join(','))
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Authorization, X-Grantex-Passport, Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    // Reject preflights from disallowed origins so misconfigured callers
    // see a clear error instead of a silent same-origin failure later.
    if (typeof origin !== 'string' || !ALLOWED_ORIGINS.has(origin)) {
      res.status(403).json({ error: 'cors_origin_not_allowed' });
      return;
    }
    res.sendStatus(204);
    return;
  }
  next();
});

// ─── MPP 402 Flow Endpoints ──────────────────────────────────────────────────

interface ResourceResponse {
  resource: string;
  category: string;
  price: number;
  currency: string;
  verifiedAgent?: VerifiedPassport;
  warning?: string;
}

interface MppChallenge {
  version: string;
  network: string;
  recipient: string;
  amount: string;
  currency: string;
  description: string;
}

const MOCK_MPP_CHALLENGE: MppChallenge = {
  version: '1.0',
  network: 'tempo-testnet',
  recipient: '0xdemo_merchant_wallet_address',
  amount: '0.10',
  currency: 'USDC',
  description: 'MPP payment for service resource',
};

const RESOURCES: Record<string, { category: string; data: string; price: number }> = {
  'inference-resource': {
    category: 'inference',
    data: '{"model":"gpt-4","tokens":1024,"result":"The answer to your question is..."}',
    price: 0.10,
  },
  'compute-resource': {
    category: 'compute',
    data: '{"taskId":"compute_01","cores":4,"duration":"30s","result":"computation complete"}',
    price: 0.25,
  },
  'data-resource': {
    category: 'data',
    data: '{"dataset":"market-prices","rows":1000,"format":"csv","url":"https://data.example.com/..."}',
    price: 0.05,
  },
  'storage-resource': {
    category: 'storage',
    data: '{"bucket":"agent-uploads","key":"file_01","size":"10MB","url":"https://storage.example.com/..."}',
    price: 0.02,
  },
};

function handleResource(resourceName: string) {
  return async (req: express.Request, res: express.Response) => {
    const resource = RESOURCES[resourceName];
    if (!resource) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND' });
      return;
    }

    const paymentHeader = req.headers['authorization'] as string | undefined;
    const passportHeader = req.headers['x-grantex-passport'] as string | undefined;

    // Step 1: No payment header → 402 Payment Required (MPP challenge)
    if (!paymentHeader || !paymentHeader.startsWith('Payment ')) {
      res.status(402).json({
        error: 'PAYMENT_REQUIRED',
        mppChallenge: {
          ...MOCK_MPP_CHALLENGE,
          amount: String(resource.price),
          description: `Payment for ${resourceName}`,
        },
      });
      return;
    }

    // Step 2: Payment present but no passport → deliver with warning
    if (!passportHeader) {
      const response: ResourceResponse = {
        resource: resource.data,
        category: resource.category,
        price: resource.price,
        currency: 'USDC',
        warning: 'no agent identity provided — service delivered without identity verification',
      };
      res.json(response);
      return;
    }

    // Step 3: Both payment and passport present → verify passport
    try {
      const verified = await verifyPassport(passportHeader, {
        // For demo: trust any issuer (no JWKS fetch needed for mock)
        trustedIssuers: ['did:web:grantex.dev'],
        requiredCategories: [resource.category as 'inference' | 'compute' | 'data' | 'storage'],
      });

      const response: ResourceResponse = {
        resource: resource.data,
        category: resource.category,
        price: resource.price,
        currency: 'USDC',
        verifiedAgent: verified,
      };
      res.json(response);
    } catch (err) {
      if (err instanceof PassportVerificationError) {
        res.status(403).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      res.status(500).json({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };
}

// Register resource endpoints
app.get('/api/inference-resource', handleResource('inference-resource'));
app.get('/api/compute-resource', handleResource('compute-resource'));
app.get('/api/data-resource', handleResource('data-resource'));
app.get('/api/storage-resource', handleResource('storage-resource'));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mpp-demo-service' });
});

const PORT = parseInt(process.env['MPP_DEMO_SERVICE_PORT'] ?? '3010', 10);

app.listen(PORT, () => {
  console.log(`MPP Demo Service listening on port ${PORT}`);
});
