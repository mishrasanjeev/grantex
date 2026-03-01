import type { EventDestination, GrantexEvent, DatadogConfig } from '../types.js';

export class DatadogDestination implements EventDestination {
  readonly name = 'datadog';
  private readonly apiKey: string;
  private readonly site: string;
  private readonly service: string;
  private readonly source: string;
  private buffer: GrantexEvent[] = [];
  private readonly batchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DatadogConfig) {
    this.apiKey = config.apiKey;
    this.site = config.site ?? 'datadoghq.com';
    this.service = config.service ?? 'grantex';
    this.source = config.source ?? 'grantex';
    this.batchSize = config.batchSize ?? 100;

    if (config.flushIntervalMs) {
      this.flushTimer = setInterval(() => { this.flush().catch(() => {}); }, config.flushIntervalMs);
    }
  }

  async send(events: GrantexEvent[]): Promise<void> {
    this.buffer.push(...events);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.batchSize);

    const logs = batch.map((e) => ({
      ddsource: this.source,
      ddtags: `type:${e.type}`,
      hostname: 'grantex-auth-service',
      message: JSON.stringify(e),
      service: this.service,
    }));

    const res = await fetch(`https://http-intake.logs.${this.site}/api/v2/logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': this.apiKey,
      },
      body: JSON.stringify(logs),
    });

    if (!res.ok) {
      throw new Error(`Datadog API error: ${res.status}`);
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
