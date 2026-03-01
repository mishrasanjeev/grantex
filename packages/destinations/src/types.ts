export interface GrantexEvent {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface EventDestination {
  name: string;
  send(events: GrantexEvent[]): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface DestinationConfig {
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface DatadogConfig extends DestinationConfig {
  apiKey: string;
  site?: string;
  service?: string;
  source?: string;
}

export interface SplunkConfig extends DestinationConfig {
  hecUrl: string;
  hecToken: string;
  index?: string;
  source?: string;
  sourcetype?: string;
}

export interface S3Config extends DestinationConfig {
  bucket: string;
  prefix?: string;
  region?: string;
}

export interface BigQueryConfig extends DestinationConfig {
  projectId: string;
  datasetId: string;
  tableId: string;
}

export interface KafkaConfig extends DestinationConfig {
  brokers: string[];
  topic: string;
  clientId?: string;
}
