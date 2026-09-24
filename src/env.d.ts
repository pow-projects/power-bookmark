declare module '*.css';

declare const __SYNC_COOLDOWN_MS__: number;
declare const __CHROME_EXTENSION_ID__: string;
declare const __FIREFOX_EXTENSION_ID__: string;

interface ImportMetaEnv {
  readonly MODE?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly WXT_DEV_WEBDAV_URL?: string;
  readonly WXT_DEV_WEBDAV_USERNAME?: string;
  readonly WXT_DEV_WEBDAV_PASSWORD?: string;
  readonly WXT_DEV_AI_PROVIDER?: string;
  readonly WXT_DEV_AI_ENDPOINT?: string;
  readonly WXT_DEV_AI_MODEL?: string;
  readonly WXT_DEV_AI_API_KEY?: string;
}
