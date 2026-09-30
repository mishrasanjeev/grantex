import { useEffect, useState, type ReactNode } from 'react';
import { listConsentNotices, listConsentRecords, listGrievances } from '../../api/dpdp';
import type { ConsentNoticePage, ConsentRecordPage, GrievancePage } from '../../api/dpdp';
import { Card } from '../../components/ui/Card';
import { formatDate } from '../../lib/format';
import { isGrievanceOverdue } from '../dpdp/status';

// Factual DPDP indicators read from the DPDP endpoints. No scores or percentages:
// these are counts of what the service holds, labelled with how much was read.

const LIMIT = 200;

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; data: T };

function useLoad<T>(fn: () => Promise<T>): Load<T> {
  const [value, setValue] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    fn()
      .then((data) => { if (live) setValue({ state: 'ok', data }); })
      .catch(() => { if (live) setValue({ state: 'error' }); });
    return () => { live = false; };
  }, []);
  return value;
}

function Indicator({ label, load, children }: { label: string; load: Load<unknown>; children: () => ReactNode }) {
  return (
    <section aria-label={label}>
      <Card className="h-full">
        <p className="text-xs text-gx-muted mb-1">{label}</p>
        {load.state === 'loading' && <p className="text-sm text-gx-muted">Loading...</p>}
        {load.state === 'error' && <p className="text-sm text-gx-muted">Unavailable</p>}
        {load.state === 'ok' && children()}
      </Card>
    </section>
  );
}

function ConsentRecordsIndicator({ load }: { load: Load<ConsentRecordPage> }) {
  return (
    <Indicator label="Consent records" load={load}>
      {() => {
        if (load.state !== 'ok') return null;
        const { records, totalRecords } = load.data;
        const counts = new Map<string, number>();
        for (const r of records) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        const complete = records.length >= totalRecords;
        return (
          <>
            <p className="text-2xl font-bold font-mono text-gx-text">{totalRecords}</p>
            {records.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2 text-xs text-gx-muted">
                <span>{complete ? 'By status:' : `In the latest ${records.length} records:`}</span>
                {[...counts.entries()].map(([status, n]) => (
                  <span key={status}>{`${n} ${status}`}</span>
                ))}
              </div>
            )}
          </>
        );
      }}
    </Indicator>
  );
}

function OpenGrievancesIndicator({ submitted, inReview }: { submitted: Load<GrievancePage>; inReview: Load<GrievancePage> }) {
  const load: Load<null> =
    submitted.state === 'error' || inReview.state === 'error'
      ? { state: 'error' }
      : submitted.state === 'loading' || inReview.state === 'loading'
        ? { state: 'loading' }
        : { state: 'ok', data: null };
  return (
    <Indicator label="Open grievances" load={load}>
      {() => {
        if (submitted.state !== 'ok' || inReview.state !== 'ok') return null;
        const open = [...submitted.data.grievances, ...inReview.data.grievances];
        const more = submitted.data.nextCursor !== null || inReview.data.nextCursor !== null;
        const overdue = open.filter((g) => isGrievanceOverdue(g)).length;
        const nearest = open
          .map((g) => g.expectedResolutionBy)
          .filter((d) => Number.isFinite(Date.parse(d)))
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        return (
          <>
            <p className="text-2xl font-bold font-mono text-gx-text">{`${open.length}${more ? '+' : ''}`}</p>
            <div className="flex flex-col gap-1 mt-2 text-xs text-gx-muted">
              <span>{`${submitted.data.grievances.length} submitted, ${inReview.data.grievances.length} in review`}</span>
              {nearest && <span>{`Next response due ${formatDate(nearest)}`}</span>}
              {overdue > 0 && <span className="text-gx-danger">{`${overdue} overdue`}</span>}
            </div>
          </>
        );
      }}
    </Indicator>
  );
}

function NoticesIndicator({ load }: { load: Load<ConsentNoticePage> }) {
  return (
    <Indicator label="Consent notice versions" load={load}>
      {() => {
        if (load.state !== 'ok') return null;
        const partial = load.data.nextCursor !== null;
        return (
          <>
            <p className="text-2xl font-bold font-mono text-gx-text">{`${load.data.notices.length}${partial ? '+' : ''}`}</p>
            {partial && <p className="mt-2 text-xs text-gx-muted">Counted from the first page of {LIMIT}</p>}
          </>
        );
      }}
    </Indicator>
  );
}

export function DpdpIndicators() {
  const records = useLoad(() => listConsentRecords({ limit: LIMIT }));
  const submitted = useLoad(() => listGrievances({ status: 'submitted', limit: LIMIT }));
  const inReview = useLoad(() => listGrievances({ status: 'in_review', limit: LIMIT }));
  const notices = useLoad(() => listConsentNotices({ limit: LIMIT }));

  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-gx-text mb-3">DPDP records</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ConsentRecordsIndicator load={records} />
        <OpenGrievancesIndicator submitted={submitted} inReview={inReview} />
        <NoticesIndicator load={notices} />
      </div>
    </div>
  );
}
