import type { EventDestination, GrantexEvent, S3Config } from '../types.js';

export class S3Destination implements EventDestination {
  readonly name = 's3';
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region: string;
  private buffer: GrantexEvent[] = [];
  private readonly batchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? 'grantex-events';
    this.region = config.region ?? 'us-east-1';
    this.batchSize = config.batchSize ?? 1000;

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

    const ndjson = batch.map((e) => JSON.stringify(e)).join('\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${this.prefix}/${timestamp}.ndjson`;

    // Use AWS SDK v3 — loaded dynamically to keep the package lightweight
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: this.region });
    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: ndjson,
      ContentType: 'application/x-ndjson',
    }));
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
