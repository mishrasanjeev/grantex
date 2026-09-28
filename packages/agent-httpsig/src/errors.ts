// SPDX-License-Identifier: Apache-2.0

/**
 * Raised for input the library refuses to process: a malformed structured
 * field, a signature base that cannot be built (RFC 9421 section 2.5), a key
 * or option outside the profile. A request that fails verification is not an
 * error: `verify()` answers it with a denial.
 */
export class AgentHttpSigError extends Error {
  override name = 'AgentHttpSigError';
}
