import { api } from './client';
import type { Developer, SignupRequest, SignupResponse, RotateKeyResponse } from './types';

export function getMe(): Promise<Developer> {
  return api.get<Developer>('/v1/me');
}

export function signup(data: SignupRequest): Promise<SignupResponse> {
  return api.post<SignupResponse>('/v1/signup', data);
}

export function rotateKey(): Promise<RotateKeyResponse> {
  return api.post<RotateKeyResponse>('/v1/keys/rotate');
}
