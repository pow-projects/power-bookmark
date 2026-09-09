import db from './db';
import { AI_SETTINGS_KEYS } from './ai/types';
import { saveWebdavSettings } from './sync/webdav-settings';

/**
 * Development (dev) only default settings seed.
 *
 * When the extension is loaded via `npm run dev` (WXT dev), it populates empty configuration
 * entries with default values to automatically connect to local development servers.
 * Values already manually configured by the user are never overwritten (skipped if the target seed key exists).
 *
 * - WebDAV  : http://localhost:8085 (webdav-test/compose.yml default)
 *   Credentials are not included in the URL — stored as a host-only URL + separate username/password
 *   (webdav_username / webdav_password, with encrypted password).
 * - AI      : custom provider → http://localhost:8080/v1
 *   (OpenAI-compatible local LLM router such as llama.cpp)
 */
export async function seedDevSettings(): Promise<void> {
  const webdavUrl = import.meta.env.WXT_DEV_WEBDAV_URL || 'http://localhost:8085/';
  const webdavUsername = import.meta.env.WXT_DEV_WEBDAV_USERNAME || 'admin';
  const webdavPassword = import.meta.env.WXT_DEV_WEBDAV_PASSWORD || 'password123';

  const defaultAiProvider = import.meta.env.WXT_DEV_AI_PROVIDER || 'custom';
  const defaultAiEndpoint = import.meta.env.WXT_DEV_AI_ENDPOINT || (defaultAiProvider === 'custom' ? 'http://localhost:8080/v1' : '');
  const defaultAiModel = import.meta.env.WXT_DEV_AI_MODEL || (defaultAiProvider === 'custom' ? 'gemma-4-E4B-it-Q6_K' : '');
  const defaultAiApiKey = import.meta.env.WXT_DEV_AI_API_KEY || '';

  // --- WebDAV ---
  const syncProvider = (await db.settings.get('sync_provider'))?.value;
  if (!syncProvider) {
    if (!(await db.settings.get('webdav_url'))?.value) {
      await saveWebdavSettings({
        url: webdavUrl,
        username: webdavUsername,
        password: webdavPassword
      });
    }
    await db.settings.put({ key: 'webdav_connected', value: true });
    await db.settings.put({ key: 'sync_provider', value: 'webdav' });
  } else if (syncProvider === 'webdav') {
    const webdavConnected = (await db.settings.get('webdav_connected'))?.value;
    if (!webdavConnected && (await db.settings.get('webdav_url'))?.value) {
      await db.settings.put({ key: 'webdav_connected', value: true });
    }
  }

  // --- AI ---
  const aiProvider = (await db.settings.get(AI_SETTINGS_KEYS.PROVIDER))?.value;
  if (!aiProvider || aiProvider === 'none') {
    await db.settings.put({ key: AI_SETTINGS_KEYS.PROVIDER, value: defaultAiProvider });
    if (defaultAiEndpoint && !(await db.settings.get(AI_SETTINGS_KEYS.CUSTOM_ENDPOINT))?.value) {
      await db.settings.put({
        key: AI_SETTINGS_KEYS.CUSTOM_ENDPOINT,
        value: defaultAiEndpoint
      });
    }
    if (defaultAiModel && !(await db.settings.get(AI_SETTINGS_KEYS.MODEL))?.value) {
      await db.settings.put({
        key: AI_SETTINGS_KEYS.MODEL,
        value: defaultAiModel
      });
    }
    if (defaultAiModel && !(await db.settings.get(AI_SETTINGS_KEYS.CUSTOM_MODEL))?.value) {
      await db.settings.put({
        key: AI_SETTINGS_KEYS.CUSTOM_MODEL,
        value: defaultAiModel
      });
    }
    if (defaultAiApiKey && !(await db.settings.get(AI_SETTINGS_KEYS.API_KEY))?.value) {
      await db.settings.put({
        key: AI_SETTINGS_KEYS.API_KEY,
        value: defaultAiApiKey
      });
      const existingMap = (await db.settings.get(AI_SETTINGS_KEYS.API_KEYS_MAP))?.value || {};
      await db.settings.put({
        key: AI_SETTINGS_KEYS.API_KEYS_MAP,
        value: { ...existingMap, [defaultAiProvider]: defaultAiApiKey }
      });
    }
  }
}
