import { CloudStorageAdapter, createHttpError, type FileInfo } from './base';
import db from '../../db';

export class DropboxAdapter extends CloudStorageAdapter {
  private clientId: string = '';
  private clientSecret: string = '';
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry = 0;

  constructor() {
    super();
  }

  private async loadCredentials() {
    const savedClientId = (await db.settings.get('dropbox_client_id'))?.value;
    this.clientId = savedClientId || '';
    const savedClientSecret = (await db.settings.get('dropbox_client_secret'))?.value;
    this.clientSecret = savedClientSecret || '';
    this.accessToken = (await db.settings.get('dropbox_access_token'))?.value || null;
    this.refreshToken = (await db.settings.get('dropbox_refresh_token'))?.value || null;
    this.tokenExpiry = Number((await db.settings.get('dropbox_token_expiry'))?.value || 0);
  }

  private async saveCredentials(access: string, refresh: string | null, expiry: number) {
    this.accessToken = access;
    this.tokenExpiry = expiry;
    await db.settings.put({ key: 'dropbox_access_token', value: access });
    await db.settings.put({ key: 'dropbox_token_expiry', value: String(expiry) });
    if (refresh) {
      this.refreshToken = refresh;
      await db.settings.put({ key: 'dropbox_refresh_token', value: refresh });
    }
  }

  async authenticate(forceInteractive = false): Promise<void> {
    await this.loadCredentials();

    if (!this.clientId) {
      throw new Error(i18n.t('adapters.dropbox.noAppKey'));
    }

    if (!forceInteractive) {
      if (this.accessToken && this.tokenExpiry > Date.now()) {
        return;
      }

      if (this.refreshToken) {
        try {
          await this.refreshAccessToken();
          return;
        } catch (e) {
          console.warn('Failed to refresh Dropbox token:', e);
        }
      }

      throw new Error(i18n.t('adapters.dropbox.invalidAuth'));
    }

    const redirectUri = browser.identity.getRedirectURL();
    const verifier = this.generateVerifier();
    const challenge = await this.generateChallenge(verifier);

    const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('token_access_type', 'offline');

    const responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl.href,
      interactive: true
    });

    if (!responseUrl) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'Dropbox' }));
    }

    const urlObj = new URL(responseUrl);
    const code = urlObj.searchParams.get('code');
    if (!code) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'Dropbox' }));
    }

    await this.exchangeCodeForTokens(code, verifier, redirectUri);
  }

  private generateVerifier(): string {
    const arr = new Uint32Array(32);
    crypto.getRandomValues(arr);
    return Array.from(arr, dec => ('0' + dec.toString(16)).slice(-2)).join('');
  }

  private async generateChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async exchangeCodeForTokens(code: string, verifier: string, redirectUri: string) {
    const tokenUrl = 'https://api.dropboxapi.com/oauth2/token';
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri
    });
    if (this.clientSecret) {
      params.set('client_secret', this.clientSecret);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Dropbox Token exchange failed: ${err}`);
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000;
    await this.saveCredentials(data.access_token, data.refresh_token || null, expiry);
  }

  private async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token available');
    const tokenUrl = 'https://api.dropboxapi.com/oauth2/token';
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId
    });
    if (this.clientSecret) {
      params.set('client_secret', this.clientSecret);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      throw new Error('Dropbox Refresh token exchange failed');
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000;
    await this.saveCredentials(data.access_token, data.refresh_token || null, expiry);
  }

  private async getHeaders(): Promise<Record<string, string>> {
    await this.authenticate();
    return {
      'Authorization': `Bearer ${this.accessToken}`
    };
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  async readFile(path: string): Promise<string> {
    const headers = await this.getHeaders();
    const url = 'https://content.dropboxapi.com/2/files/download';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Dropbox-API-Arg': JSON.stringify({ path: this.normalizePath(path) })
      }
    });

    if (!res.ok) {
      if (res.status === 409 || res.status === 404) {
        throw new Error(`File not found: ${path}`);
      }
      throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'Dropbox', status: res.statusText }));
    }
    return await res.text();
  }

  async writeFile(path: string, data: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = 'https://content.dropboxapi.com/2/files/upload';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Dropbox-API-Arg': JSON.stringify({
          path: this.normalizePath(path),
          mode: 'overwrite',
          autorename: false,
          mute: true,
          strict_conflict: false
        }),
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });

    if (!res.ok) {
      throw createHttpError(res.status, i18n.t('adapters.errors.writeFailed', { provider: 'Dropbox', status: res.statusText }));
    }
  }

  /**
   * Ensures 'archives' folder exists. Creates if missing, no-op if present (ignores 409). (idempotent)
   */
  async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const headers = await this.getHeaders();
    const url = 'https://api.dropboxapi.com/2/files/create_folder_v2';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: this.normalizePath(folder), autorename: false })
    });
    // 409 (already exists) is treated as success — idempotent
    if (!res.ok && res.status !== 409) {
      throw createHttpError(res.status, i18n.t('adapters.errors.createFolderFailed', { provider: 'Dropbox', status: res.statusText }));
    }
  }

  async writeBinaryFile(path: string, data: Blob, mimeType = 'application/octet-stream'): Promise<void> {
    const { folder, name } = this.splitArchivePath(path);
    if (folder) await this.ensureFolder(folder);
    const headers = await this.getHeaders();
    const url = 'https://content.dropboxapi.com/2/files/upload';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Dropbox-API-Arg': JSON.stringify({
          path: this.normalizePath(folder ? `${folder}/${name}` : name),
          mode: 'overwrite',
          autorename: false,
          mute: true,
          strict_conflict: false
        }),
        'Content-Type': 'application/octet-stream'
      },
      body: data
    });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.writeFailed', { provider: 'Dropbox', status: res.statusText }));
  }

  async readBinaryFile(path: string): Promise<Blob> {
    const headers = await this.getHeaders();
    const url = 'https://content.dropboxapi.com/2/files/download';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Dropbox-API-Arg': JSON.stringify({ path: this.normalizePath(path) })
      }
    });
    if (!res.ok) {
      if (res.status === 409 || res.status === 404) {
        throw new Error(`File not found: ${path}`);
      }
      throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'Dropbox', status: res.statusText }));
    }
    return await res.blob();
  }

  async deleteFile(path: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = 'https://api.dropboxapi.com/2/files/delete_v2';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: this.normalizePath(path) })
    });
    // 404/409 (missing) is no-op — idempotent
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      throw createHttpError(res.status, i18n.t('adapters.errors.deleteFailed', { provider: 'Dropbox', status: res.statusText }));
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
      const headers = await this.getHeaders();
      const url = 'https://api.dropboxapi.com/2/files/get_metadata';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': headers['Authorization'],
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: this.normalizePath(path) })
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return new Date(data.server_modified || 0).getTime();
    } catch (e) {
      return 0;
    }
  }

  async listFiles(folder: string): Promise<FileInfo[]> {
    const headers = await this.getHeaders();
    const url = 'https://api.dropboxapi.com/2/files/list_folder';
    const folderPath = folder === '/' || !folder ? '' : this.normalizePath(folder);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': headers['Authorization'],
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: folderPath })
    });

    if (!res.ok) {
      if (res.status === 409 || res.status === 404) return [];
      throw createHttpError(res.status, i18n.t('adapters.errors.listFailed', { provider: 'Dropbox', status: res.statusText }));
    }
    const data = await res.json();
    return (data.entries || []).map((f: any) => ({
      name: f.name,
      modifiedAt: new Date(f.server_modified || 0).getTime(),
      size: Number(f.size || 0)
    }));
  }

  async revoke(): Promise<void> {
    await this.loadCredentials();
    if (this.accessToken) {
      try {
        await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
      } catch (e) {
        console.warn('Revoke token failed:', e);
      }
    }
    await db.settings.delete('dropbox_client_id');
    await db.settings.delete('dropbox_client_secret');
    await db.settings.delete('dropbox_access_token');
    await db.settings.delete('dropbox_refresh_token');
    await db.settings.delete('dropbox_token_expiry');
    this.clientId = '';
    this.clientSecret = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }
}
