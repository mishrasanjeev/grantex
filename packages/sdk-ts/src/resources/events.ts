import type { HttpClient } from '../http.js';

export interface GrantexEvent {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface StreamOptions {
  types?: string[];
}

export type EventHandler = (event: GrantexEvent) => void | Promise<void>;

export class EventsClient {
  #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Connect to the SSE event stream.
   * Returns an async iterable of events.
   */
  async *stream(options?: StreamOptions): AsyncGenerator<GrantexEvent> {
    const params = new URLSearchParams();
    if (options?.types?.length) {
      params.set('types', options.types.join(','));
    }
    const qs = params.toString();
    const url = `/v1/events/stream${qs ? '?' + qs : ''}`;

    const res = await this.#http.rawGet(url);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to connect to event stream: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              yield JSON.parse(line.slice(6)) as GrantexEvent;
            } catch { /* skip malformed */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Subscribe to events with a callback handler.
   * Returns a function to unsubscribe.
   */
  subscribe(handler: EventHandler, options?: StreamOptions): { unsubscribe: () => void } {
    const controller = new AbortController();
    const run = async () => {
      for await (const event of this.stream(options)) {
        if (controller.signal.aborted) break;
        await handler(event);
      }
    };
    run().catch(() => {});

    return {
      unsubscribe: () => controller.abort(),
    };
  }
}
