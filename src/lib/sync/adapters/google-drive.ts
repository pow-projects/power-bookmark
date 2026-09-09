import { CloudStorageAdapter, createHttpError, type FileInfo } from './base';
import db from '../../db';

export class GoogleDriveAdapter extends CloudStorageAdapter {
  private clientId: string = '';
  private clientSecret: string = '';
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry = 0;

  constructor() {
    super();
  }

  /**
   * Dynamically reads API key / OAuth information from settings.
   */
  private async loadCredentials() {
    const savedClientId = (await db.settings.get('gdrive_client_id'))?.value;
    this.clientId = savedClientId || '';
    const savedClientSecret = (await db.settings.get('gdrive_client_secret'))?.value;
    this.clientSecret = savedClientSecret || '';
    this.accessToken = (await db.settings.get('gdrive_access_token'))?.value || null;
    this.refreshToken = (await db.settings.get('gdrive_refresh_token'))?.value || null;
    this.tokenExpiry = Number((await db.settings.get('gdrive_token_expiry'))?.value || 0);
  }

  /**
   * Permanently stores credentials.
   */
  private async saveCredentials(access: string, refresh: string | null, expiry: number) {
    this.accessToken = access;
    this.tokenExpiry = expiry;
    await db.settings.put({ key: 'gdrive_access_token', value: access });
    await db.settings.put({ key: 'gdrive_token_expiry', value: String(expiry) });
    if (refresh) {
      this.refreshToken = refresh;
      await db.settings.put({ key: 'gdrive_refresh_token', value: refresh });
    }
  }

  /**
   * Handles authentication via OAuth2 PKCE.
   */
  async authenticate(forceInteractive = false): Promise<void> {
    await this.loadCredentials();

    if (!this.clientId) {
      throw new Error(i18n.t('adapters.googleDrive.noClientId'));
    }

    if (!forceInteractive) {
      // 1. When a valid token already exists
      if (this.accessToken && this.tokenExpiry > Date.now()) {
        return;
      }

      // 2. Attempt token refresh when refresh token exists
      if (this.refreshToken) {
        try {
          await this.refreshAccessToken();
          return;
        } catch (e) {
          console.warn('Failed to refresh access token:', e);
        }
      }

      throw new Error(i18n.t('adapters.googleDrive.invalidAuth'));
    }

    // 3. New login (launchWebAuthFlow)
    const redirectUri = browser.identity.getRedirectURL();
    
    // Generate PKCE Verifier and Challenge
    const verifier = this.generateVerifier();
    const challenge = await this.generateChallenge(verifier);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('access_type', 'offline'); // To acquire refresh token

    const responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl.href,
      interactive: true
    });

    if (!responseUrl) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'Google Drive' }));
    }

    const urlObj = new URL(responseUrl);
    const code = urlObj.searchParams.get('code');
    if (!code) {
      throw new Error(i18n.t('adapters.errors.authCodeMissing', { provider: 'Google Drive' }));
    }

    // Exchange code for token
    await this.exchangeCodeForTokens(code, verifier, redirectUri);
  }

  private generateVerifier(): string {
    const arr = new Uint32Array(32);
    crypto.getRandomValues(arr);
    return Array.from(arr, dec => ('0' + dec.toString(16)).substr(-2)).join('');
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
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
      client_id: this.clientId,
      code_verifier: verifier,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
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
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000; // 1-minute safety margin
    await this.saveCredentials(data.access_token, data.refresh_token || null, expiry);
  }

  private async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token available');
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
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
      throw new Error('Refresh token exchange failed');
    }

    const data = await response.json();
    const expiry = Date.now() + (data.expires_in * 1000) - 60000;
    await this.saveCredentials(data.access_token, null, expiry);
  }

  /**
   * Provides Access Token header during API calls
   */
  private async getHeaders(): Promise<Record<string, string>> {
    await this.authenticate(); // Auto-refresh if necessary
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Queries file metadata (including ID) matching a specific file name in appDataFolder.
   */
  private async findFileId(filename: string): Promise<string | null> {
    const headers = await this.getHeaders();
    const query = encodeURIComponent(`name = '${filename}' and 'appDataFolder' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size)`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.queryFailed', { provider: 'Google Drive', status: res.statusText }));
    
    const data = await res.json();
    const files: Array<{ id: string; name: string; modifiedTime?: string; size?: string | number }> = data.files || [];
    if (files.length === 0) {
      return null;
    }

    const chosenFile = files.find(f => Number(f.size || 0) > 0) || files[0];

    if (files.length > 1) {
      const staleFiles = files.filter(f => f.id !== chosenFile.id);
      Promise.allSettled(
        staleFiles.map(f =>
          fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': headers['Authorization'] }
          })
        )
      ).catch(err => {
        console.warn('Failed to clean up stale Google Drive duplicate files:', err);
      });
    }

    return chosenFile.id || null;
  }

  async readFile(path: string): Promise<string> {
    const fileId = await this.findFileId(path);
    if (!fileId) {
      throw new Error(`File not found: ${path}`);
    }

    const headers = await this.getHeaders();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': headers['Authorization'] }
    });

    if (!res.ok) {
      throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'Google Drive', status: res.statusText }));
    }
    return await res.text();
  }

  async writeFile(path: string, data: string): Promise<void> {
    const fileId = await this.findFileId(path);
    const headers = await this.getHeaders();

    if (fileId) {
      // Overwrite (Update)
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
      const res = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': headers['Authorization'],
          'Content-Type': 'text/plain'
        },
        body: data
      });
      if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.updateFailed', { provider: 'Google Drive', status: res.statusText }));
    } else {
      // Create new
      // Step 1: Upload metadata
      const metaUrl = 'https://www.googleapis.com/drive/v3/files';
      const metaRes = await fetch(metaUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: path,
          parents: ['appDataFolder']
        })
      });
      if (!metaRes.ok) throw createHttpError(metaRes.status, i18n.t('adapters.errors.metadataCreateFailed', { provider: 'Google Drive', status: metaRes.statusText }));
      const metaData = await metaRes.json();
      const newFileId = metaData.id;

      // Step 2: Upload content (PATCH)
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${newFileId}?uploadType=media`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': headers['Authorization'],
          'Content-Type': 'text/plain'
        },
        body: data
      });
      if (!uploadRes.ok) throw createHttpError(uploadRes.status, i18n.t('adapters.errors.writeFailed', { provider: 'Google Drive', status: uploadRes.statusText }));
    }
  }

  /** Splits 'archives/<fileName>' path into { folder, name }. */
  private splitArchivePath(path: string): { folder: string; name: string } {
    const slash = path.indexOf('/');
    if (slash < 0) return { folder: '', name: path };
    return { folder: path.slice(0, slash), name: path.slice(slash + 1) };
  }

  /**
   * Queries file metadata (including ID) matching file name within a specific folder (folderId).
   * Existing flat `findFileId` (for appDataFolder root) is retained, keeping folder-aware lookup for archives separate.
   */
  private async findFileIdInFolder(folderId: string, name: string): Promise<string | null> {
    const headers = await this.getHeaders();
    const query = encodeURIComponent(`name = '${name}' and '${folderId}' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.queryFailed', { provider: 'Google Drive', status: res.statusText }));

    const data = await res.json();
    return data.files?.[0]?.id || null;
  }

  /**
   * Resolves folder ID for a given folder name in appDataFolder (queries remote if not cached).
   * If createIfMissing is true, creates the folder if not found.
   */
  async resolveFolderId(folder: string, createIfMissing = false): Promise<string | null> {
    if (!folder || folder === 'appDataFolder') return 'appDataFolder';
    const cacheKey = `gdrive_${folder}_folder_id`;
    const cached = (await db.settings.get(cacheKey))?.value;
    if (cached) return cached;

    const headers = await this.getHeaders();
    // 1) Query existing folder in appDataFolder
    const query = encodeURIComponent(`name = '${folder}' and mimeType = 'application/vnd.google-apps.folder' and 'appDataFolder' in parents and trashed = false`);
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`;
    const listRes = await fetch(listUrl, { headers });
    if (listRes.ok) {
      const data = await listRes.json();
      const existing = data.files?.[0]?.id;
      if (existing) {
        await db.settings.put({ key: cacheKey, value: existing });
        return existing;
      }
    }

    if (!createIfMissing) {
      return null;
    }

    // 2) Create if missing
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: folder, mimeType: 'application/vnd.google-apps.folder', parents: ['appDataFolder'] })
    });
    if (!createRes.ok) throw createHttpError(createRes.status, i18n.t('adapters.errors.createFolderFailed', { provider: 'Google Drive', status: createRes.statusText }));
    const meta = await createRes.json();
    if (meta.id) {
      await db.settings.put({ key: cacheKey, value: meta.id });
      return meta.id;
    }
    return null;
  }

  /**
   * Ensures 'archives' folder exists. Caches folderId in settings; queries and creates if missing. (idempotent)
   */
  async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    await this.resolveFolderId(folder, true);
  }

  async writeBinaryFile(path: string, data: Blob, mimeType = 'application/octet-stream'): Promise<void> {
    const { folder, name } = this.splitArchivePath(path);
    const folderId = folder ? (await this.resolveFolderId(folder, true)) || 'appDataFolder' : 'appDataFolder';
    const headers = await this.getHeaders();
    const fileId = folder ? await this.findFileIdInFolder(folderId, name) : await this.findFileId(name);

    if (fileId) {
      // Overwrite (Update)
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
      const res = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: { 'Authorization': headers['Authorization'], 'Content-Type': mimeType },
        body: data
      });
      if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.updateFailed', { provider: 'Google Drive', status: res.statusText }));
      return;
    }

    // Create new — upload media after creating metadata
    const metaRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, parents: [folderId] })
    });
    if (!metaRes.ok) throw createHttpError(metaRes.status, i18n.t('adapters.errors.metadataCreateFailed', { provider: 'Google Drive', status: metaRes.statusText }));
    const meta = await metaRes.json();
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${meta.id}?uploadType=media`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: { 'Authorization': headers['Authorization'], 'Content-Type': mimeType },
      body: data
    });
    if (!uploadRes.ok) throw createHttpError(uploadRes.status, i18n.t('adapters.errors.writeFailed', { provider: 'Google Drive', status: uploadRes.statusText }));
  }

  async readBinaryFile(path: string): Promise<Blob> {
    const { folder, name } = this.splitArchivePath(path);
    const folderId = folder ? await this.resolveFolderId(folder, false) : 'appDataFolder';
    if (folder && !folderId) {
      throw createHttpError(404, `File not found: ${path}`);
    }
    const fileId = folder && folderId ? await this.findFileIdInFolder(folderId, name) : await this.findFileId(name);
    if (!fileId) throw createHttpError(404, `File not found: ${path}`);

    const headers = await this.getHeaders();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': headers['Authorization'] }
    });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.readFailed', { provider: 'Google Drive', status: res.statusText }));
    return await res.blob();
  }

  async deleteFile(path: string): Promise<void> {
    const { folder, name } = this.splitArchivePath(path);
    const folderId = folder ? await this.resolveFolderId(folder, false) : 'appDataFolder';
    if (folder && !folderId) return; // no-op if folder does not exist (idempotent)
    const fileId = folder && folderId ? await this.findFileIdInFolder(folderId, name) : await this.findFileId(name);
    if (!fileId) return; // no-op if missing (idempotent)
    const headers = await this.getHeaders();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': headers['Authorization'] }
    });
    if (!res.ok && res.status !== 404) throw createHttpError(res.status, i18n.t('adapters.errors.deleteFailed', { provider: 'Google Drive', status: res.statusText }));
  }

  async getLastModified(path: string): Promise<number> {
    const { folder, name } = this.splitArchivePath(path);
    const folderId = folder ? await this.resolveFolderId(folder, false) : 'appDataFolder';
    if (folder && !folderId) return 0;
    const fileId = folder && folderId
      ? await this.findFileIdInFolder(folderId, name)
      : await this.findFileId(path);
    if (!fileId) return 0;

    const headers = await this.getHeaders();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`, { headers });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.metadataQueryFailed', { provider: 'Google Drive', status: res.statusText }));
    
    const data = await res.json();
    return new Date(data.modifiedTime).getTime();
  }

  async listFiles(folder: string): Promise<FileInfo[]> {
    const headers = await this.getHeaders();
    let parentQuery = "'appDataFolder' in parents";
    if (folder && folder !== 'appDataFolder') {
      const folderId = await this.resolveFolderId(folder, false);
      if (!folderId) return [];
      parentQuery = `'${folderId}' in parents`;
    }
    const query = encodeURIComponent(`${parentQuery} and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name,modifiedTime,size)`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw createHttpError(res.status, i18n.t('adapters.errors.listFailed', { provider: 'Google Drive', status: res.statusText }));
    
    const data = await res.json();
    return (data.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      modifiedAt: new Date(f.modifiedTime).getTime(),
      size: Number(f.size || 0)
    }));
  }

  async revoke(): Promise<void> {
    await this.loadCredentials();
    if (this.accessToken) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${this.accessToken}`, { method: 'POST' });
      } catch (e) {
        console.warn('Revoke token failed:', e);
      }
    }
    // Reset DB information
    await db.settings.delete('gdrive_client_id');
    await db.settings.delete('gdrive_client_secret');
    await db.settings.delete('gdrive_access_token');
    await db.settings.delete('gdrive_refresh_token');
    await db.settings.delete('gdrive_token_expiry');
    await db.settings.delete('gdrive_archives_folder_id');
    this.clientId = '';
    this.clientSecret = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }
}
