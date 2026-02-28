import { API_BASE_URL } from '../lib/constants';

let _adminKey: string | null = null;

export function setAdminKey(key: string) {
  _adminKey = key;
  sessionStorage.setItem('gx_admin_key', key);
}

export function getAdminKey(): string | null {
  if (!_adminKey) {
    _adminKey = sessionStorage.getItem('gx_admin_key');
  }
  return _adminKey;
}

export function clearAdminKey() {
  _adminKey = null;
  sessionStorage.removeItem('gx_admin_key');
}

async function adminRequest<T>(method: string, path: string): Promise<T> {
  const key = getAdminKey();
  if (!key) throw new Error('Admin API key not set');

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

export interface AdminStats {
  totalDevelopers: number;
  last24h: number;
  last7d: number;
  last30d: number;
  byMode: Record<string, number>;
  totalAgents: number;
  totalGrants: number;
}

export interface Developer {
  id: string;
  name: string;
  email: string | null;
  mode: string;
  createdAt: string;
}

export interface DeveloperListResponse {
  developers: Developer[];
  total: number;
  page: number;
  pageSize: number;
}

export function fetchStats(): Promise<AdminStats> {
  return adminRequest<AdminStats>('GET', '/v1/admin/stats');
}

export function fetchDevelopers(page = 1, pageSize = 50): Promise<DeveloperListResponse> {
  return adminRequest<DeveloperListResponse>(
    'GET',
    `/v1/admin/developers?page=${page}&pageSize=${pageSize}`,
  );
}
