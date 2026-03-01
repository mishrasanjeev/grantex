import type { EventDestination, GrantexEvent } from './types.js';

export interface EventSourceOptions {
  url: string;
  apiKey: string;
  types?: string[];
}

/**
 * EventSource connects to the Grantex SSE endpoint and dispatches
 * events to one or more configured destinations.
 */
export class EventSource {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly types: string[] | null;
  private readonly destinations: EventDestination[] = [];
  private abortController: AbortController | null = null;

  constructor(options: EventSourceOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.types = options.types ?? null;
  }

  addDestination(destination: EventDestination): void {
    this.destinations.push(destination);
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const params = new URLSearchParams();
    if (this.types) {
      params.set('types', this.types.join(','));
    }
    const url = `${this.url}/v1/events/stream${this.types ? '?' + params.toString() : ''}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: this.abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to connect to event stream: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const event: GrantexEvent = JSON.parse(data);
            await this.dispatch(event);
          } catch { /* skip malformed events */ }
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    for (const dest of this.destinations) {
      await dest.flush?.();
      await dest.close?.();
    }
  }

  private async dispatch(event: GrantexEvent): Promise<void> {
    await Promise.allSettled(
      this.destinations.map((d) => d.send([event])),
    );
  }
}
