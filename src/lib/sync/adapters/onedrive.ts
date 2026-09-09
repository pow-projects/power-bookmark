import { CloudStorageAdapter, createHttpError, type FileInfo } from './base';
import db from '../../db';

export class OneDriveAdapter extends CloudStorageAdapter {
  private clientId: string = '';
  private clientSecret: string = '';
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry = 0;

  constructor() {
    super();
  }

  private async loadCredentials() {
    const savedClientId = (await db.settings.get('onedrive_client_id'))?.value;
    this.clientId = savedClientId || '';
    const savedClientSecret = (await db.settings.get('onedrive_client_secret'))?.value;
    this.clientSecret = savedClientSecret || '';
    this.accessToken = (await db.settings.get('onedrive_access_token'))?.value || null;
    this.refreshToken = (await db.settings.get('onedrive_refresh_token'))?.value || null;
    this.tokenExpiry = Number((await db.settings.get('onedrive_token_expiry'))?.value || 0);
  }

  private async saveCredentials(access: string, refresh: string | null, expiry: number) {
    this.accessToken = access;
    this.tokenExpiry = expiry;
    await db.settings.put({ key: 'onedrive_access_token', value: access });
    await db.settings.put({ key: 'onedrive_token_expiry', value: String(expiry) });
    if (refresh) {
      this.refreshToken = refresh;
      await db.settings.put({ key: 'onedrive_refresh_token', value: refresh });
    }
  }

  async authenticate(forceInteractive = false): Promise<void> {
    await this.loadCredentials();

    if (!this.clientId) {
      throw new Error(i18n.t('adapters.onedrive.noClientId'));
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
          console.warn('Failed to refresh OneDrive token:', e);
        }
      }

      throw new Error(i18n.t('adapters.onedrive.invalidAuth'));
    }

    const redirectUri = browser.identity.getRedirectURL();
    const verifier = this.generateVerifier();
    const challenge = await this.generateChallenge(verifier);

    const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'files.readwrite files.readwrite.all offline_access');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl.href,
      interactive: true
    });

    if (!responseUrl) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'OneDrive' }));
    }

    const urlObj = new URL(responseUrl);
    const code = urlObj.searchParams.get('code');
    if (!code) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'OneDrive' }));
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
    const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    const params = new URLSearchParams({
      client_id: this.clientId,
      code_verifier: verifier,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'files.readwrite files.readwrite.all offline_access'
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
      throw new Error(`OneDrive Token exchange failed: ${err}`);
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000;
    await this.saveCredentials(data.access_token, data.refresh_token || null, expiry);
  }

  private async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token available');
    const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    const params = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
      scope: 'files.readwrite files.readwrite.all offline_access'
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
      throw new Error('OneDrive Refresh token exchange failed');
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000;
    await this.saveCredentials(data.access_token, data.refresh_token || null, expiry);
  }

  private async getHeaders(): Promise<Record<string, string>> {
    await this.authenticate();
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async readFile(path: string): Promise<string> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${path}:/content`;
    const res = await fetch(url, { headers: { 'Authorization': headers['Authorization'] } });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`File not found: ${path}`);
      }
      throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'OneDrive', status: res.statusText }));
    }
    return await res.text();
  }

  async writeFile(path: string, data: string): Promise<void> {
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${path}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': headers['Authorization'],
        'Content-Type': 'text/plain'
      },
      body: data
    });
    if (!res.ok) {
      throw createHttpError(res.status, i18n.t('adapters.errors.writeFailed', { provider: 'OneDrive', status: res.statusText }));
    }
  }

  /** Splits 'archives/<fileName>' path into { folder, name }. */
  private splitArchivePath(path: string): { folder: string; name: string } {
    const slash = path.indexOf('/');
    if (slash < 0) return { folder: '', name: path };
    return { folder: path.slice(0, slash), name: path.slice(slash + 1) };
  }

  /**
   * Ensures 'archives' folder exists. Creates if missing, no-op if present. (idempotent)
   */
  async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const headers = await this.getHeaders();
    // Check existence
    const checkUrl = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${folder}`;
    const checkRes = await fetch(checkUrl, { headers });
    if (checkRes.ok) return; // Already exists → no-op

    // 404/409 → Create
    const createUrl = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${folder}`;
    const createRes = await fetch(createUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        name: folder,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail'
      })
    });
    // 409 (already exists) is treated as success — idempotent
    if (!createRes.ok && createRes.status !== 409) {
      throw createHttpError(createRes.status, i18n.t('adapters.errors.createFolderFailed', { provider: 'OneDrive', status: createRes.statusText }));
    }
  }

  async writeBinaryFile(path: string, data: Blob, mimeType = 'application/octet-stream'): Promise<void> {
    const { folder, name } = this.splitArchivePath(path);
    if (folder) await this.ensureFolder(folder);
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${folder ? folder + '/' : ''}${name}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': headers['Authorization'],
        'Content-Type': mimeType
      },
      body: data
    });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.writeFailed', { provider: 'OneDrive', status: res.statusText }));
  }

  async readBinaryFile(path: string): Promise<Blob> {
    const { folder, name } = this.splitArchivePath(path);
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${folder ? folder + '/' : ''}${name}:/content`;
    const res = await fetch(url, { headers: { 'Authorization': headers['Authorization'] } });
    if (!res.ok) {
      throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'OneDrive', status: res.statusText }));
    }
    return await res.blob();
  }

  async deleteFile(path: string): Promise<void> {
    const { folder, name } = this.splitArchivePath(path);
    const headers = await this.getHeaders();
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${folder ? folder + '/' : ''}${name}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': headers['Authorization'] }
    });
    // 404 (missing) is no-op — idempotent
    if (!res.ok && res.status !== 404) {
      throw createHttpError(res.status, i18n.t('adapters.errors.deleteFailed', { provider: 'OneDrive', status: res.statusText }));
    }
  }

  async getLastModified(path: string): Promise<number> {
    try {
      const headers = await this.getHeaders();
      const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${path}`;
      const res = await fetch(url, { headers });
      if (!res.ok) return 0;
      const data = await res.json();
      return new Date(data.lastModifiedDateTime || 0).getTime();
    } catch (e) {
      return 0;
    }
  }

  async listFiles(folder: string): Promise<FileInfo[]> {
    const headers = await this.getHeaders();
    const path = folder === 'approot' || !folder ? '' : `:/${folder}`;
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot${path}:/children`;
    
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 404) return [];
      throw createHttpError(res.status, i18n.t('adapters.errors.listFailed', { provider: 'OneDrive', status: res.statusText }));
    }
    const data = await res.json();
    return (data.value || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      modifiedAt: new Date(f.lastModifiedDateTime || 0).getTime(),
      size: Number(f.size || 0)
    }));
  }

  async revoke(): Promise<void> {
    await this.loadCredentials();
    await db.settings.delete('onedrive_client_id');
    await db.settings.delete('onedrive_client_secret');
    await db.settings.delete('onedrive_access_token');
    await db.settings.delete('onedrive_refresh_token');
    await db.settings.delete('onedrive_token_expiry');
    this.clientId = '';
    this.clientSecret = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }
}
