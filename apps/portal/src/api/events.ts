import { API_BASE_URL } from '../lib/constants';
import { ApiError, getApiKey } from './client';

export interface EventRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface EventWire {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

interface SubscribeOptions {
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: EventRecord) => void;
}

function parseEventBlock(block: string): EventRecord | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;

  try {
    const event = JSON.parse(data) as EventWire;
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.createdAt !== 'string') {
      return null;
    }
    return {
      id: event.id,
      type: event.type,
      payload: event.data && typeof event.data === 'object' ? event.data : {},
      createdAt: event.createdAt,
    };
  } catch {
    return null;
  }
}

export async function subscribeToEvents({ signal, onOpen, onEvent }: SubscribeOptions): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const apiKey = getApiKey();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${API_BASE_URL}/v1/events/stream`, { headers, signal });
  if (!response.ok) {
    throw new ApiError(response.status, 'EVENT_STREAM_ERROR', response.statusText || 'Event stream failed');
  }
  if (!response.body) {
    throw new ApiError(response.status, 'EVENT_STREAM_ERROR', 'Event stream is unavailable');
  }

  onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = parseEventBlock(block);
      if (event) onEvent(event);
    }
  }
}
