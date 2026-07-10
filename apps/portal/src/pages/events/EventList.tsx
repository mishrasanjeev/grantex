import { useState, useEffect } from 'react';
import { subscribeToEvents } from '../../api/events';
import type { EventRecord } from '../../api/events';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { timeAgo } from '../../lib/format';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger';

function eventBadge(type: string) {
  const map: Record<string, { variant: BadgeVariant; label: string }> = {
    'grant.created': { variant: 'success', label: 'grant.created' },
    'grant.revoked': { variant: 'danger', label: 'grant.revoked' },
    'budget.threshold': { variant: 'warning', label: 'budget.threshold' },
    'budget.exhausted': { variant: 'danger', label: 'budget.exhausted' },
  };

  const entry = map[type];
  if (entry) {
    return <Badge variant={entry.variant}>{entry.label}</Badge>;
  }

  // token.issued gets a blue style (accent2) — no built-in Badge variant for blue
  if (type === 'token.issued') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono bg-gx-accent2/15 text-gx-accent2">
        token.issued
      </span>
    );
  }

  return <Badge>{type}</Badge>;
}

function truncatePayload(payload: Record<string, unknown>, maxLen = 80): string {
  const json = JSON.stringify(payload);
  if (json.length <= maxLen) return json;
  return json.slice(0, maxLen) + '\u2026';
}

export function EventList() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const { show } = useToast();

  useEffect(() => {
    if (paused) {
      setConnected(false);
      return;
    }

    const controller = new AbortController();
    setConnected(false);
    void subscribeToEvents({
      signal: controller.signal,
      onOpen: () => {
        setConnected(true);
        setLoading(false);
      },
      onEvent: (event) => {
        setEvents((current) => [event, ...current].slice(0, 100));
      },
    }).catch(() => {
      if (!controller.signal.aborted) {
        setConnected(false);
        setLoading(false);
        show('Failed to connect to event stream', 'error');
      }
    });

    return () => {
      controller.abort();
    };
  }, [paused, show]);

  if (loading) return <Spinner />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gx-text">Events</h1>
          {connected && !paused && (
            <span className="flex items-center gap-1.5 text-xs text-gx-accent font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gx-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-gx-accent" />
              </span>
              Live
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors bg-gx-surface border border-gx-border text-gx-muted hover:text-gx-text"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <Card className="p-0">
        {events.length === 0 ? (
          <EmptyState title="No events yet" description="Events will appear here as they occur." />
        ) : (
          <div className="p-4">
            <Table
              data={events}
              rowKey={(e) => e.id}
              columns={[
                {
                  key: 'time',
                  header: 'Time',
                  render: (e) => (
                    <span className="text-gx-muted text-sm whitespace-nowrap">{timeAgo(e.createdAt)}</span>
                  ),
                },
                {
                  key: 'type',
                  header: 'Event Type',
                  render: (e) => eventBadge(e.type),
                },
                {
                  key: 'payload',
                  header: 'Payload',
                  render: (e) => (
                    <span className="font-mono text-xs text-gx-muted">{truncatePayload(e.payload)}</span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
