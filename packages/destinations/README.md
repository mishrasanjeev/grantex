# @grantex/destinations

Streams Grantex events to Datadog, Splunk HEC, Amazon S3, Google BigQuery, or Kafka.

## Install

```bash
npm install @grantex/destinations
```

For S3, BigQuery, or Kafka, also install the corresponding provider package: `@aws-sdk/client-s3`, `@google-cloud/bigquery`, or `kafkajs`.

## Quick start

```typescript
import { DatadogDestination, EventSource } from '@grantex/destinations';

const source = new EventSource({
  url: 'https://api.grantex.dev',
  apiKey: process.env.GRANTEX_API_KEY!,
  types: ['grant.created', 'grant.revoked'],
});

source.addDestination(new DatadogDestination({
  apiKey: process.env.DATADOG_API_KEY!,
  service: 'grantex',
  batchSize: 100,
  flushIntervalMs: 5_000,
}));

await source.start();
```

Call `await source.stop()` during shutdown to abort the SSE connection and flush/close every destination.

## Destinations

- `DatadogDestination`
- `SplunkDestination`
- `S3Destination`
- `BigQueryDestination`
- `KafkaDestination`

You can also implement `EventDestination` with a `send(events)` method and register your own connector with `source.addDestination()`.

## Requirements

- Node.js 18+
- A Grantex API key with access to the event stream

## License

Apache-2.0
