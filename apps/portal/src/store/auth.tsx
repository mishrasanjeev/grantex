import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { setApiKey } from '../api/client';
import { getMe } from '../api/auth';
import type { Developer } from '../api/types';

interface AuthState {
  apiKey: string | null;
  developer: Developer | null;
  loading: boolean;
  login: (key: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = 'grantex_api_key';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setKey] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [loading, setLoading] = useState(!!localStorage.getItem(STORAGE_KEY));

  const login = useCallback(async (key: string) => {
    setApiKey(key);
    const dev = await getMe();
    localStorage.setItem(STORAGE_KEY, key);
    setKey(key);
    setDeveloper(dev);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setApiKey(null);
    setKey(null);
    setDeveloper(null);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    setApiKey(stored);
    getMe()
      .then((dev) => {
        setDeveloper(dev);
      })
      .catch(() => {
        localStorage.removeItem(STORAGE_KEY);
        setApiKey(null);
        setKey(null);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ apiKey, developer, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
