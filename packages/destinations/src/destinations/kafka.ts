import type { EventDestination, GrantexEvent, KafkaConfig } from '../types.js';

export class KafkaDestination implements EventDestination {
  readonly name = 'kafka';
  private readonly brokers: string[];
  private readonly topic: string;
  private readonly clientId: string;
  private buffer: GrantexEvent[] = [];
  private readonly batchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: KafkaConfig) {
    this.brokers = config.brokers;
    this.topic = config.topic;
    this.clientId = config.clientId ?? 'grantex-destinations';
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

    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({ clientId: this.clientId, brokers: this.brokers });
    const producer = kafka.producer();

    await producer.connect();
    await producer.send({
      topic: this.topic,
      messages: batch.map((e) => ({
        key: e.id,
        value: JSON.stringify(e),
        headers: { 'event-type': e.type },
      })),
    });
    await producer.disconnect();
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
