import db from '../db';
import { encryptCredential } from './crypto';

/**
 * Helper to store and reuse WebDAV authentication credentials under separate keys (webdav_username / webdav_password).
 *
 * Background: To allow entering host-only URL (e.g. http://localhost:8085) and separate username/password fields,
 * userinfo is separated and stripped to avoid leaving plain-text password in the URL upon saving.
 * (Maintains backwards compatibility with legacy URL userinfo credentials — if userinfo is present,
 *  it takes precedence, is stored separately, and stored URL is always clean without userinfo.)
 */

export interface NormalizedWebdavAuth {
  url: string;
  username: string;
  password: string;
}

/**
 * Normalizes input values.
 * - If URL includes `username:password@` userinfo, applies it with precedence (legacy compatibility),
 * - Returned url is always a clean URL with userinfo stripped.
 */
export function normalizeWebdavAuth(
  url: string,
  username = '',
  password = ''
): NormalizedWebdavAuth {
  let cleanUrl = url.trim();
  let u = username || '';
  let p = password || '';

  if (cleanUrl) {
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.username) {
        try {
          u = decodeURIComponent(parsed.username);
        } catch {
          u = parsed.username;
        }
      }
      if (parsed.password) {
        try {
          p = decodeURIComponent(parsed.password);
        } catch {
          p = parsed.password;
        }
      }
      parsed.username = '';
      parsed.password = '';
      cleanUrl = parsed.toString();
    } catch {
      // Keep original if URL cannot be parsed
    }
  }

  return { url: cleanUrl, username: u, password: p };
}

/**
 * Saves WebDAV connection settings.
 * - webdav_url: Always saved as clean URL with userinfo stripped (prevents plain-text password exposure).
 * - webdav_username: Plain text.
 * - webdav_password: Encrypted with AES-GCM and saved (decrypted by decryptCredential in webdav.ts loadCredentials).
 * - If password is an empty string, treated as "no change" to retain existing stored value.
 */
export async function saveWebdavSettings(opts: {
  url: string;
  username?: string;
  password?: string;
}): Promise<void> {
  const normalized = normalizeWebdavAuth(opts.url, opts.username, opts.password);

  await db.settings.put({ key: 'webdav_url', value: normalized.url });
  await db.settings.put({ key: 'webdav_username', value: normalized.username });

  if (normalized.password && normalized.password !== '****') {
    const encrypted = await encryptCredential(normalized.password);
    await db.settings.put({ key: 'webdav_password', value: encrypted });
  }
  // Retain existing webdav_password if password is empty or masked ('****') (no change)
}