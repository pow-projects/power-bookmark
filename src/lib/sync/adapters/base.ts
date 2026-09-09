export interface FileInfo {
  name: string;
  id?: string;
  modifiedAt: number;
  size?: number;
}

/**
 * CloudStorageAdapter — Abstract class to handle SDK/API of each cloud service in a unified manner
 */
export abstract class CloudStorageAdapter {
  /**
   * Authenticates with cloud storage service (OAuth2 PKCE, etc.).
   */
  abstract authenticate(forceInteractive?: boolean): Promise<void>;

  /**
   * Reads file content from specified path.
   */
  abstract readFile(path: string): Promise<string>;

  /**
   * Writes file data to specified path (overwrite).
   */
  abstract writeFile(path: string, data: string): Promise<void>;

  /**
   * Uploads binary (Blob) data (overwrite).
   * Assumes application/octet-stream if mimeType is omitted.
   * Dedicated for archive storage — new method separate from existing writeFile(string),
   * preserving sync-engine's writeFile/readFile signature for powerbookmark_sync.json.
   */
  abstract writeBinaryFile(path: string, data: Blob, mimeType?: string): Promise<void>;

  /**
   * Downloads binary data. Throws if file not found.
   */
  abstract readBinaryFile(path: string): Promise<Blob>;

  /**
   * Deletes a file. Idempotent no-op (no exceptions thrown) if file does not exist.
   */
  abstract deleteFile(path: string): Promise<void>;

  /**
   * Ensures folder path exists. Creates if missing, no-op if present — idempotent.
   */
  abstract ensureFolder(folder: string): Promise<void>;

  /**
   * Retrieves last modified timestamp of file at specified path.
   */
  abstract getLastModified(path: string): Promise<number>;

  /**
   * Lists files in a specific folder (or app data dedicated scope).
   */
  abstract listFiles(folder: string): Promise<FileInfo[]>;

  /**
   * Performs logout / token revocation.
   */
  abstract revoke(): Promise<void>;
}

/**
 * Creates an HTTP failure error. Attaches `status` (HTTP status number) to Error object
 * so classifyArchiveError (archive-cloud) can classify 401/403 → auth, 5xx/429 → transient, etc.
 * Shared helper to avoid duplication across adapters.
 */
export function createHttpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * Shared helper converting Blob to ArrayBuffer.
 * (Used because WebDAV v5 `putFileContents` acceptance of Blob/ArrayBuffer varies by version,
 *  bypassing via base64 string when only string is accepted.)
 */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await blob.arrayBuffer();
}

/**
 * Conversion helper ensuring binary transfer depending on whether WebDAV v5 `putFileContents` accepts strings only.
 * Returns string (mostly) or ArrayBuffer; uses base64 encoding when converting to string.
 * (WebDAV-only fallback accepting performance overhead — applied to WebDAV only in `lib/archive-cloud.ts`)
 */
export async function blobToUploadPayload(blob: Blob): Promise<string | ArrayBuffer> {
  // String is always a safe accepted type, so convert to base64 string.
  // Although base64 encoding expands size by ~33%, it is the only universal method
  // to reliably transfer binaries across WebDAV (desktop/server sync).
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
