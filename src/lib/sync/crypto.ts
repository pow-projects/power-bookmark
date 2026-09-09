export interface EncryptedPayload {
  __encrypted: true;
  data: string;
  iv: string;
}

const MASTER_KEY_STORAGE_KEY = 'master_key';
let cachedMasterKey: CryptoKey | null = null;

function getCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    return window.crypto;
  }
  throw new Error('Web Crypto API (crypto.subtle) is not supported in this environment');
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function getStoredMasterKeyJwk(): Promise<JsonWebKey | null> {
  // 1. browser.storage.local
  if (typeof browser !== 'undefined' && browser?.storage?.local) {
    try {
      const res = await browser.storage.local.get(MASTER_KEY_STORAGE_KEY);
      if (res && res[MASTER_KEY_STORAGE_KEY]) {
        return res[MASTER_KEY_STORAGE_KEY] as JsonWebKey;
      }
    } catch (e) {
      // fallback
    }
  }

  // 2. chrome.storage.local
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    try {
      const res = await new Promise<any>((resolve) => {
        chrome.storage.local.get([MASTER_KEY_STORAGE_KEY], (items) => {
          resolve(items || {});
        });
      });
      if (res && res[MASTER_KEY_STORAGE_KEY]) {
        return res[MASTER_KEY_STORAGE_KEY] as JsonWebKey;
      }
    } catch (e) {
      // fallback
    }
  }

  return null;
}

async function setStoredMasterKeyJwk(jwk: JsonWebKey): Promise<void> {
  // 1. browser.storage.local
  if (typeof browser !== 'undefined' && browser?.storage?.local) {
    try {
      await browser.storage.local.set({ [MASTER_KEY_STORAGE_KEY]: jwk });
      return;
    } catch (e) {
      // ignore
    }
  }

  // 2. chrome.storage.local
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    try {
      await new Promise<void>((resolve) => {
        chrome.storage.local.set({ [MASTER_KEY_STORAGE_KEY]: jwk }, () => {
          resolve();
        });
      });
      return;
    } catch (e) {
      // ignore
    }
  }
}

/**
 * AES-GCM 256-bit master key generation/loading module based on
 * secure storage (browser.storage.local / chrome.storage.local) dedicated for WXT/Chrome extension.
 */
export async function getOrCreateMasterKey(forceRefresh = false): Promise<CryptoKey> {
  if (cachedMasterKey && !forceRefresh) {
    return cachedMasterKey;
  }

  const cryptoObj = getCrypto();
  const jwk = await getStoredMasterKeyJwk();

  if (jwk) {
    try {
      const key = await cryptoObj.subtle.importKey(
        'jwk',
        jwk,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      cachedMasterKey = key;
      return key;
    } catch (e: any) {
      throw new Error(`Failed to import existing master key: ${e?.message || e}`);
    }
  }

  const newKey = await cryptoObj.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const exportedJwk = await cryptoObj.subtle.exportKey('jwk', newKey);
  await setStoredMasterKeyJwk(exportedJwk);

  cachedMasterKey = newKey;
  return newKey;
}

/**
 * Resets CryptoKey cached in memory (for testing purposes, etc.)
 */
export function resetMasterKeyCache(): void {
  cachedMasterKey = null;
}

/**
 * Encrypts plain-text credentials (password, etc.) with 12-byte random IV and AES-GCM 256-bit, returning Base64 result.
 */
export async function encryptCredential(plainText: string): Promise<EncryptedPayload> {
  if (typeof plainText !== 'string') {
    throw new TypeError('plainText must be a string');
  }

  const cryptoObj = getCrypto();
  const key = await getOrCreateMasterKey();

  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(plainText);

  const cipherBuffer = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedText
  );

  return {
    __encrypted: true,
    data: uint8ArrayToBase64(new Uint8Array(cipherBuffer)),
    iv: uint8ArrayToBase64(iv)
  };
}

/**
 * Decrypts encrypted credential object.
 * Returns as-is if string (plain text) for legacy migration and backwards compatibility.
 */
export async function decryptCredential(payload: any): Promise<string> {
  if (payload === null || payload === undefined) {
    return '';
  }

  let target = payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && parsed.__encrypted === true) {
          target = parsed;
        }
      } catch (e) {
        // Keep as-is if plain text string
      }
    }
  }

  if (typeof target === 'string') {
    return target;
  }

  if (typeof target !== 'object' || target.__encrypted !== true) {
    return String(target);
  }

  if (typeof target.data !== 'string' || typeof target.iv !== 'string') {
    throw new Error('Invalid encrypted payload format');
  }

  const cryptoObj = getCrypto();
  const key = await getOrCreateMasterKey();

  const cipherUint8 = base64ToUint8Array(target.data);
  const ivUint8 = base64ToUint8Array(target.iv);

  try {
    const decryptedBuffer = await cryptoObj.subtle.decrypt(
      { name: 'AES-GCM', iv: ivUint8 as BufferSource },
      key,
      cipherUint8 as BufferSource
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (e: any) {
    throw new Error(`Failed to decrypt credential: ${e.message}`);
  }
}
