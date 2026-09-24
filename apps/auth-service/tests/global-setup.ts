import { checkSharedDatabase, snapshotSharedDatabase } from './helpers/shared-database-guard.js';

/**
 * Runs once around the whole suite. With a shared database configured, it
 * records that database's tables first and fails the run afterwards if any
 * test file added to them; see `./helpers/shared-database-guard.ts`.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const url = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
  if (!url) return undefined;
  const before = await snapshotSharedDatabase(url);
  return () => checkSharedDatabase(url, before);
}
