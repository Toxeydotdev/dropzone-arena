/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  readonly VITE_ONLINE_AUTHORITY_URL?: string;
  readonly VITE_ONLINE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
