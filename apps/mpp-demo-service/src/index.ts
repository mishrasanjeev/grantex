import express from 'express';
import { verifyPassport, PassportVerificationError } from '@grantex/mpp';
import type { VerifiedPassport } from '@grantex/mpp';

const app = express();
app.use(express.json());

// Enable CORS for demo UI
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, X-Grantex-Passport, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (_req.method === 'OPTIONS') {
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
