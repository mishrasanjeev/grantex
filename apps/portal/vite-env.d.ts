/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Default off; `'true'` shows the DPDP indicators on the compliance dashboard. */
  readonly VITE_DPDP_DASHBOARD_INDICATORS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
