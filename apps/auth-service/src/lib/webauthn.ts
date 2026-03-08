import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import { config } from '../config.js';

export interface StoredCredential {
  credentialId: string;
  publicKey: string; // base64url
  counter: number;
  transports: string[];
}

export async function generateRegOptions(
  principalId: string,
  rpName: string,
  existingCredentials: StoredCredential[],
) {
  return generateRegistrationOptions({
    rpName,
    rpID: config.fidoRpId,
    userName: principalId,
    userID: new TextEncoder().encode(principalId),
    attestationType: 'direct',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
  });
}

export async function verifyRegResponse(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.fidoOrigin,
    expectedRPID: config.fidoRpId,
  });
}

export async function generateAuthOptions(
  credentials: StoredCredential[],
) {
  return generateAuthenticationOptions({
    rpID: config.fidoRpId,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: 'preferred',
  });
}

export async function verifyAuthResponse(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: StoredCredential,
) {
  const uint8Key = Buffer.from(credential.publicKey, 'base64url');
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.fidoOrigin,
    expectedRPID: config.fidoRpId,
    credential: {
      id: credential.credentialId,
      publicKey: uint8Key,
      counter: credential.counter,
      transports: credential.transports as AuthenticatorTransportFuture[],
    },
  });
}
