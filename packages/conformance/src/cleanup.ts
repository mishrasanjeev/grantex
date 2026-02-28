import type { ConformanceHttpClient } from './http-client.js';

export class CleanupTracker {
  private agents: string[] = [];
  private grants: string[] = [];
  private policies: string[] = [];
  private webhooks: string[] = [];

  constructor(private readonly http: ConformanceHttpClient) {}

  trackAgent(id: string): void {
    this.agents.push(id);
  }

  trackGrant(id: string): void {
    this.grants.push(id);
  }

  trackPolicy(id: string): void {
    this.policies.push(id);
  }

  trackWebhook(id: string): void {
    this.webhooks.push(id);
  }

  async teardown(): Promise<void> {
    // Delete in reverse order of dependency: grants → agents → policies → webhooks
    for (const id of this.grants) {
      try {
        await this.http.delete(`/v1/grants/${id}`);
      } catch {
        // best-effort
      }
    }
    for (const id of this.agents) {
      try {
        await this.http.delete(`/v1/agents/${id}`);
      } catch {
        // best-effort
      }
    }
    for (const id of this.policies) {
      try {
        await this.http.delete(`/v1/policies/${id}`);
      } catch {
        // best-effort
      }
    }
    for (const id of this.webhooks) {
      try {
        await this.http.delete(`/v1/webhooks/${id}`);
      } catch {
        // best-effort
      }
    }

    this.agents = [];
    this.grants = [];
    this.policies = [];
    this.webhooks = [];
  }
}
