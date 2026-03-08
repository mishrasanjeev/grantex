import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../store/toast';
import { Card } from '../../components/ui/Card';
import { Table } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { formatDate } from '../../lib/format';

interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  verificationToken: string;
  createdAt: string;
}

export function DomainList() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const { show } = useToast();

  useEffect(() => {
    api.get<{ domains: Domain[] }>('/v1/domains')
      .then((res) => setDomains(res.domains ?? []))
      .catch(() => show('Failed to load domains', 'error'))
      .finally(() => setLoading(false));
  }, [show]);

  if (loading) return <Spinner />;

  return (
    <div>
      <h1 className="text-xl font-semibold text-gx-text mb-6">Custom Domains</h1>

      <Card className="p-0">
        {domains.length === 0 ? (
          <EmptyState title="No custom domains" description="Add a custom domain to get started." />
        ) : (
          <div className="p-4">
            <Table
              data={domains}
              rowKey={(d) => d.id}
              columns={[
                {
                  key: 'domain',
                  header: 'Domain',
                  render: (d) => <span className="font-mono text-sm text-gx-text">{d.domain}</span>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (d) =>
                    d.verified ? (
                      <Badge variant="success">Verified</Badge>
                    ) : (
                      <Badge variant="warning">Pending</Badge>
                    ),
                },
                {
                  key: 'createdAt',
                  header: 'Created',
                  render: (d) => <span className="text-gx-muted text-sm">{formatDate(d.createdAt)}</span>,
                },
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
