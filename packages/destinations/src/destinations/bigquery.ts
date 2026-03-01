import type { EventDestination, GrantexEvent, BigQueryConfig } from '../types.js';

export class BigQueryDestination implements EventDestination {
  readonly name = 'bigquery';
  private readonly projectId: string;
  private readonly datasetId: string;
  private readonly tableId: string;
  private buffer: GrantexEvent[] = [];
  private readonly batchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BigQueryConfig) {
    this.projectId = config.projectId;
    this.datasetId = config.datasetId;
    this.tableId = config.tableId;
    this.batchSize = config.batchSize ?? 500;

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

    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId: this.projectId });
    const table = bq.dataset(this.datasetId).table(this.tableId);

    const rows = batch.map((e) => ({
      event_id: e.id,
      event_type: e.type,
      created_at: e.createdAt,
      data: JSON.stringify(e.data),
    }));

    await table.insert(rows);
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
