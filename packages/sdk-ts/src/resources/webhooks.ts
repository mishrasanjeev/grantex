import type { HttpClient } from '../http.js';
import type {
  CreateWebhookParams,
  WebhookEndpointWithSecret,
  ListWebhooksResponse,
} from '../types.js';

export class WebhooksClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  create(params: CreateWebhookParams): Promise<WebhookEndpointWithSecret> {
    return this.#http.post('/v1/webhooks', params);
  }

  list(): Promise<ListWebhooksResponse> {
    return this.#http.get('/v1/webhooks');
  }

  delete(webhookId: string): Promise<void> {
    return this.#http.delete(`/v1/webhooks/${webhookId}`);
  }
}
