// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * The licence notice the auth service logs once at startup, so whoever runs
 * the service sees the licence terms in its logs. Fixed text: it carries no
 * configuration, tenant or request data.
 */
export const LICENCE_STARTUP_NOTICE =
  'Grantex platform is licensed under the Orchestrum Personal Use License 1.0. '
  + 'Any use by or for an organisation, including evaluation, pilots, self-hosting '
  + 'and deployment, needs a signed agreement with Orchestrum Technologies LLP. '
  + 'See LICENSE and COMMERCIAL-LICENSE.md '
  + '(https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md) '
  + 'or contact sanjeev@orchestrum.in.';

export function logLicenceNotice(warn: (message: string) => void = console.warn): void {
  warn(`[licence] ${LICENCE_STARTUP_NOTICE}`);
}
