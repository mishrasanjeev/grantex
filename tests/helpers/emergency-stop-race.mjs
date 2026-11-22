import postgres from 'postgres';
import { setTimeout } from 'node:timers/promises';

export async function createEmergencyStopRaceBarrier({ databaseUrl, developerId, postgresFactory = postgres }) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('A local release database URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]', 'pg', 'postgres'].includes(url.hostname)
    || url.pathname.length < 2 || url.hash) throw new Error('A local release database URL is required');
  if (typeof developerId !== 'string' || !/^dev_[a-zA-Z0-9_-]+$/.test(developerId)) {
    throw new Error('The disposable developer identity is required');
  }
  const sql = postgresFactory(databaseUrl, { max: 2, connect_timeout: 5 });
  let session;
  let locked = false;
  let queued = false;
  let closed = false;
  const unlock = async () => {
    if (!locked) return;
    const [row] = await session`SELECT pg_advisory_unlock(hashtextextended(${developerId}, 4)) AS unlocked`;
    if (row?.unlocked !== true) throw new Error('The release barrier unlock was not confirmed');
    locked = false;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await unlock(); } finally {
      try { session?.release(); } finally { await sql.end({ timeout: 5 }); }
    }
  };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await setTimeout(5);
    }
    throw new Error(message);
  };
  try {
    session = await sql.reserve();
    const [owner] = await session`SELECT pg_backend_pid() AS pid`;
    if (!Number.isInteger(Number(owner?.pid)) || Number(owner.pid) < 1) throw new Error('The release barrier session is unknown');
    await session`SELECT pg_advisory_lock(hashtextextended(${developerId}, 4))`;
    locked = true;
    return {
      async waitForDelegation() {
        if (closed || !locked) throw new Error('The release barrier is not held');
        await waitFor(async () => {
          const [row] = await sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity a WHERE a.datname = current_database()
              AND ${Number(owner.pid)}::int = ANY(pg_blocking_pids(a.pid))
          ) AS waiting`;
          return row?.waiting === true;
        }, 'No real delegation queued behind the release barrier');
        queued = true;
      },
      async releaseForRunningStop(reason) {
        if (!queued || closed || !locked) throw new Error('The real delegation must be queued first');
        await waitFor(async () => {
          const rows = await sql`SELECT id FROM emergency_stops
            WHERE developer_id = ${developerId} AND reason = ${reason} AND status = 'running'`;
          return rows.length === 1;
        }, 'The real emergency stop did not enter its running state');
        await unlock();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
