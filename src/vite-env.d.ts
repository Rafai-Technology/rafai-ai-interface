/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the Rafai AI agent service. Leave unset to use '/api', which
   * works behind the dev proxy and behind a same-origin reverse proxy.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
