/**
 * Build-time portal feature flags, read from Vite's `import.meta.env`.
 *
 * Each flag defaults off and is enabled only by the exact string `'true'`,
 * set at build time (for example `VITE_DPDP_DASHBOARD_INDICATORS=true npm run build`).
 * Values are read on each call so tests can toggle them with `vi.stubEnv`.
 */

/**
 * Show the DPDP record indicators on the compliance dashboard. When on, each
 * dashboard visit makes four DPDP list reads (consent records, submitted and
 * in-review grievances, consent notices).
 */
export function dpdpDashboardIndicatorsEnabled(): boolean {
  return import.meta.env.VITE_DPDP_DASHBOARD_INDICATORS === 'true';
}
