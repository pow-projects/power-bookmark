import { createClient } from 'webdav';
import { CloudStorageAdapter, createHttpError, blobToArrayBuffer, type FileInfo } from './base';
import db from '../../db';
import { decryptCredential } from '../crypto';

export class WebDavAdapter extends CloudStorageAdapter {
  private client: ReturnType<typeof createClient> | null = null;
  private url = '';
  private username = '';
  private password = '';

  constructor() {
    super();
  }

  private async loadCredentials() {
    let rawUrl = (await db.settings.get('webdav_url'))?.value || '';
    let username = (await db.settings.get('webdav_username'))?.value || '';
    const rawPassword = (await db.settings.get('webdav_password'))?.value;
    let password = rawPassword ? await decryptCredential(rawPassword) : '';

    if (rawUrl) {
      try {
        const parsedUrl = new URL(rawUrl);
        if (parsedUrl.username) {
          try {
            username = decodeURIComponent(parsedUrl.username);
          } catch {
            username = parsedUrl.username;
          }
        }
        if (parsedUrl.password) {
          try {
            password = decodeURIComponent(parsedUrl.password);
          } catch {
            password = parsedUrl.password;
          }
        }
        parsedUrl.username = '';
        parsedUrl.password = '';
        rawUrl = parsedUrl.toString();
      } catch (e) {
        // URL parsing fallback
      }
    }

    this.url = rawUrl;
    this.username = username;
    this.password = password;
  }

  async authenticate(forceInteractive = false): Promise<void> {
    await this.loadCredentials();
    if (!this.url) {
      throw new Error(i18n.t('adapters.webdav.noServerUrl'));
    }

    try {
      this.client = createClient(this.url, {
        username: this.username || undefined,
        password: this.password || undefined
      });
      // Simple connection test (query root directory)
      await this.client.getDirectoryContents('/');
      await db.settings.put({ key: 'webdav_connected', value: true });
    } catch (e: any) {
      this.client = null;
      if (typeof e?.status === 'number' && (e.status === 401 || e.status === 403)) {
        await db.settings.put({ key: 'webdav_connected', value: false });
      }
      // Errors from webdav library may have status (HTTP status number) — rethrow preserving status
      // so classifyArchiveError can classify 401/403 → auth, 5xx → transient, etc.
      if (typeof e?.status === 'number') {
        throw createHttpError(e.status, i18n.t('adapters.errors.connectFailed', { message: e.message }));
      }
      throw new Error(i18n.t('adapters.errors.connectFailed', { message: e.message }));
    }
  }

  private async getClient(): Promise<ReturnType<typeof createClient>> {
    if (!this.client) {
      await this.authenticate();
    }
    if (!this.client) {
      throw new Error(i18n.t('adapters.errors.notInitialized'));
    }
    return this.client;
  }

  async readFile(path: string): Promise<string> {
    const client = await this.getClient();
    const contents = await client.getFileContents(path, { format: 'text' });
    return contents as string;
  }

  async writeFile(path: string, data: string): Promise<void> {
    const client = await this.getClient();
    await client.putFileContents(path, data);
  }

  /**
   * Ensures 'archives' folder exists. Creates via mkcol if missing, no-op if present (ignores already-exists errors). (idempotent)
   */
  async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    try {
      const client = await this.getClient();
      await client.createDirectory(folder, { recursive: true });
    } catch (e) {
      // Ignore exceptions thrown for already existing folders (idempotent).
      // Treated quietly as success since distinguishing from actual auth/connection errors is difficult.
    }
  }

  /**
   * Binary upload. Transmit original bytes converted to ArrayBuffer
   * since webdav v5 `putFileContents` accepts ArrayBuffer (BufferLike).
   */
  async writeBinaryFile(path: string, data: Blob, mimeType = 'application/octet-stream'): Promise<void> {
    const { folder } = this.splitArchivePath(path);
    if (folder) await this.ensureFolder(folder);
    const client = await this.getClient();
    const buffer = await blobToArrayBuffer(data);
    await client.putFileContents(path, buffer);
  }

  async readBinaryFile(path: string): Promise<Blob> {
    const client = await this.getClient();
    const contents = await client.getFileContents(path, { format: 'binary' });
    if (contents instanceof Blob) return contents;
    // Convert to Blob if not in a binary format like ArrayBuffer/Uint8Array
    return new Blob([contents as any], { type: 'application/octet-stream' });
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const client = await this.getClient();
      await client.deleteFile(path);
    } catch (e: any) {
      // 404 (missing) is no-op — idempotent
      if (e && (e.status === 404 || /not found/i.test(String(e.message)))) return;
      throw e;
    }
  }

  /** Splits 'archives/<fileName>' path into { folder, name }. */
  private splitArchivePath(path: string): { folder: string; name: string } {
    const slash = path.indexOf('/');
    if (slash < 0) return { folder: '', name: path };
    return { folder: path.slice(0, slash), name: path.slice(slash + 1) };
  }

  async getLastModified(path: string): Promise<number> {
    try {
      const client = await this.getClient();
      const stat = (await client.stat(path)) as any;
      // stat.lastmod can be a string (e.g. "Mon, 20 Jul 2026 00:00:00 GMT") or a Date object
      if (!stat || !stat.lastmod) return 0;
      return new Date(stat.lastmod).getTime();
    } catch (e) {
      return 0;
    }
  }

  async listFiles(folder: string): Promise<FileInfo[]> {
    try {
      const client = await this.getClient();
      const contents = await client.getDirectoryContents(folder || '/');
      if (!Array.isArray(contents)) return [];
      
      return contents.map((item: any) => ({
        name: item.basename,
        modifiedAt: item.lastmod ? new Date(item.lastmod).getTime() : 0,
        size: Number(item.size || 0)
      }));
    } catch (e) {
      return [];
    }
  }

  async revoke(): Promise<void> {
    await db.settings.delete('webdav_url');
    await db.settings.delete('webdav_username');
    await db.settings.delete('webdav_password');
    await db.settings.delete('webdav_connected');
    this.client = null;
    this.url = '';
    this.username = '';
    this.password = '';
  }
}
