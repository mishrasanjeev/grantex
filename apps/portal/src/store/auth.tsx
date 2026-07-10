import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { setApiKey } from '../api/client';
import { getMe } from '../api/auth';
import type { Developer } from '../api/types';

interface AuthState {
  apiKey: string | null;
  developer: Developer | null;
  loading: boolean;
  login: (key: string) => Promise<void>;
  replaceApiKey: (key: string) => void;
  updateDeveloper: (updates: Partial<Developer>) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = 'grantex_api_key';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setKey] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [loading, setLoading] = useState(!!sessionStorage.getItem(STORAGE_KEY));

  const replaceApiKey = useCallback((key: string) => {
    setApiKey(key);
    sessionStorage.setItem(STORAGE_KEY, key);
    setKey(key);
  }, []);

  const updateDeveloper = useCallback((updates: Partial<Developer>) => {
    setDeveloper((current) => current ? { ...current, ...updates } : current);
  }, []);

  const login = useCallback(async (key: string) => {
    const previousKey = apiKey;
    setApiKey(key);
    try {
      const dev = await getMe();
      replaceApiKey(key);
      setDeveloper(dev);
    } catch (error) {
      setApiKey(previousKey);
      throw error;
    }
  }, [apiKey, replaceApiKey]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setApiKey(null);
    setKey(null);
    setDeveloper(null);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    setApiKey(stored);
    getMe()
      .then((dev) => {
        setDeveloper(dev);
      })
      .catch(() => {
        sessionStorage.removeItem(STORAGE_KEY);
        setApiKey(null);
        setKey(null);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ apiKey, developer, loading, login, replaceApiKey, updateDeveloper, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
