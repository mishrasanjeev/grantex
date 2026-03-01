import type { EventDestination, GrantexEvent, SplunkConfig } from '../types.js';

export class SplunkDestination implements EventDestination {
  readonly name = 'splunk';
  private readonly hecUrl: string;
  private readonly hecToken: string;
  private readonly index: string;
  private readonly source: string;
  private readonly sourcetype: string;
  private buffer: GrantexEvent[] = [];
  private readonly batchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SplunkConfig) {
    this.hecUrl = config.hecUrl;
    this.hecToken = config.hecToken;
    this.index = config.index ?? 'main';
    this.source = config.source ?? 'grantex';
    this.sourcetype = config.sourcetype ?? '_json';
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

    const body = batch.map((e) => JSON.stringify({
      event: e,
      time: Math.floor(new Date(e.createdAt).getTime() / 1000),
      source: this.source,
      sourcetype: this.sourcetype,
      index: this.index,
    })).join('\n');

    const res = await fetch(`${this.hecUrl}/services/collector/event`, {
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${this.hecToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`Splunk HEC error: ${res.status}`);
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
