import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmergencyStopRaceBarrier } from '../helpers/emergency-stop-race.mjs';

function fixture({ waiting = true, unlock = true, reserveError = false } = {}) {
  const calls = [];
  const session = async (parts) => {
    const query = parts.join('?');
    if (query.includes('pg_backend_pid')) return [{ pid: 17 }];
    if (query.includes('pg_advisory_unlock')) { calls.push('unlock'); return [{ unlocked: unlock }]; }
    calls.push('lock');
    return [{}];
  };
  session.release = () => calls.push('release');
  const sql = async (parts) => {
    if (parts.join('?').includes('pg_stat_activity')) { calls.push('waiter'); return [{ waiting }]; }
    calls.push('running-stop');
    return [{ id: 'stop_fixture' }];
  };
  sql.reserve = async () => { calls.push('reserve'); if (reserveError) throw new Error('reserve refused'); return session; };
  sql.end = async () => calls.push('end');
  return { calls, factory: () => sql };
}
const options = { databaseUrl: 'postgres://fixture:fixture@127.0.0.1/grantex_test', developerId: 'dev_fixture' };

test('a real delegation must queue before a running stop releases the barrier', async () => {
  const f = fixture();
  const barrier = await createEmergencyStopRaceBarrier({ ...options, postgresFactory: f.factory });
  await barrier.waitForDelegation();
  await barrier.releaseForRunningStop('synthetic race');
  await barrier.close();
  await barrier.close();
  assert.deepEqual(f.calls, ['reserve', 'lock', 'waiter', 'running-stop', 'unlock', 'release', 'end']);
});

test('the stop cannot bypass delegation ordering and cleanup still releases its session', async () => {
  const f = fixture();
  const barrier = await createEmergencyStopRaceBarrier({ ...options, postgresFactory: f.factory });
  await assert.rejects(barrier.releaseForRunningStop('synthetic race'), /queued first/);
  await barrier.close();
  assert.deepEqual(f.calls, ['reserve', 'lock', 'unlock', 'release', 'end']);
});

test('unknown unlock state fails closed and always closes the owned connection', async () => {
  const f = fixture({ unlock: false });
  const barrier = await createEmergencyStopRaceBarrier({ ...options, postgresFactory: f.factory });
  await barrier.waitForDelegation();
  await assert.rejects(barrier.releaseForRunningStop('synthetic race'), /not confirmed/);
  await assert.rejects(barrier.close(), /not confirmed/);
  assert.deepEqual(f.calls.slice(-2), ['release', 'end']);
});

test('missing or external database URLs and missing developer identity never connect', async () => {
  let connected = 0;
  const postgresFactory = () => { connected++; throw new Error('must not connect'); };
  for (const databaseUrl of [undefined, 'invalid', 'https://example.test', 'postgres://fixture:fixture@database.example/grantex_test']) {
    await assert.rejects(createEmergencyStopRaceBarrier({ ...options, databaseUrl, postgresFactory }), /local release database/);
  }
  await assert.rejects(createEmergencyStopRaceBarrier({ ...options, developerId: undefined, postgresFactory }), /developer identity/);
  assert.equal(connected, 0);
});

test('reserve failure closes the new pool without claiming a held barrier', async () => {
  const f = fixture({ reserveError: true });
  await assert.rejects(createEmergencyStopRaceBarrier({ ...options, postgresFactory: f.factory }), /reserve refused/);
  assert.deepEqual(f.calls, ['reserve', 'end']);
});

test('a missing actual waiter is never treated as successful overlap', async () => {
  const f = fixture({ waiting: false });
  const barrier = await createEmergencyStopRaceBarrier({ ...options, postgresFactory: f.factory });
  try { await assert.rejects(barrier.waitForDelegation(), /No real delegation/); }
  finally { await barrier.close(); }
  assert.deepEqual(f.calls.slice(-3), ['unlock', 'release', 'end']);
});
