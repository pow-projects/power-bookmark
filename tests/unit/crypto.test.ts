import { describe, it, expect, beforeEach, vi } from 'vitest';

const storageMap = new Map<string, any>();

(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn((keys: string[], callback: (items: any) => void) => {
        const result: Record<string, any> = {};
        for (const key of keys) {
          if (storageMap.has(key)) {
            result[key] = storageMap.get(key);
          }
        }
        callback(result);
      }),
      set: vi.fn((items: Record<string, any>, callback?: () => void) => {
        for (const [key, value] of Object.entries(items)) {
          storageMap.set(key, value);
        }
        if (callback) callback();
      })
    }
  }
};

const { mockDb } = vi.hoisted(() => {
  const dbStore = {
    settings: {
      data: new Map<string, any>(),
      clear: async () => dbStore.settings.data.clear(),
      get: async (key: string) => {
        const val = dbStore.settings.data.get(key);
        return val !== undefined ? { key, value: val } : undefined;
      },
      put: async (item: { key: string; value: any }) => {
        dbStore.settings.data.set(item.key, item.value);
      }
    }
  };
  return { mockDb: dbStore };
});

vi.mock('../../src/lib/db', () => ({
  default: mockDb,
  db: mockDb
}));

import {
  getOrCreateMasterKey,
  encryptCredential,
  decryptCredential,
  resetMasterKeyCache
} from '../../src/lib/sync/crypto';

describe('AES-GCM Web Crypto Module (lib/crypto.ts)', () => {
  beforeEach(async () => {
    resetMasterKeyCache();
    storageMap.clear();
    await mockDb.settings.clear();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('getOrCreateMasterKey()', () => {
    it('generates a valid 256-bit AES-GCM CryptoKey and stores it in extension storage', async () => {
      const key = await getOrCreateMasterKey();
      expect(key).toBeDefined();
      expect(key.algorithm.name).toBe('AES-GCM');
      expect((key.algorithm as any).length).toBe(256);
      expect(key.extractable).toBe(true);

      // Verify stored in chrome.storage.local only
      expect(storageMap.has('master_key')).toBe(true);
      expect(await mockDb.settings.get('master_key')).toBeUndefined();
      if (typeof localStorage !== 'undefined') {
        expect(localStorage.getItem('master_key')).toBeNull();
      }
    });

    it('reuses cached or stored master key on subsequent calls', async () => {
      const key1 = await getOrCreateMasterKey();
      const key2 = await getOrCreateMasterKey();
      expect(key1).toBe(key2);

      resetMasterKeyCache();
      const key3 = await getOrCreateMasterKey();
      
      const testText = 'test-key-consistency';
      const encrypted = await encryptCredential(testText);
      const decrypted = await decryptCredential(encrypted);
      expect(decrypted).toBe(testText);
    });

    it('throws error and DOES NOT overwrite master key when importKey fails', async () => {
      const corruptedJwk = { kty: 'oct', k: '!!!invalid_base64_jwk_key!!!', alg: 'A256GCM' };
      storageMap.set('master_key', corruptedJwk);

      resetMasterKeyCache();
      await expect(getOrCreateMasterKey(true)).rejects.toThrow('Failed to import existing master key');

      // Verify the stored key was NOT overwritten
      expect(storageMap.get('master_key')).toEqual(corruptedJwk);
    });
  });

  describe('encryptCredential() & decryptCredential()', () => {
    it('encrypts plaintext into EncryptedPayload format', async () => {
      const plainText = 'MySecretP@ssw0rd!';
      const encrypted = await encryptCredential(plainText);

      expect(encrypted.__encrypted).toBe(true);
      expect(typeof encrypted.data).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(encrypted.data.length).toBeGreaterThan(0);
      expect(encrypted.iv.length).toBeGreaterThan(0);
    });

    it('uses unique IV for each encryption call', async () => {
      const plainText = 'SamePassword';
      const enc1 = await encryptCredential(plainText);
      const enc2 = await encryptCredential(plainText);

      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.data).not.toBe(enc2.data);
    });

    it('correctly encrypts and decrypts UTF-8 and unicode strings', async () => {
      const testCases = [
        'simple-secret',
        '비밀번호 🔒 1234!@#$',
        'Complex🔑P@sswørd!_가나다',
        ' ',
        ''
      ];

      for (const text of testCases) {
        const encrypted = await encryptCredential(text);
        const decrypted = await decryptCredential(encrypted);
        expect(decrypted).toBe(text);
      }
    });

    it('throws TypeError if non-string is passed to encryptCredential', async () => {
      // @ts-expect-error test runtime validation
      await expect(encryptCredential(12345)).rejects.toThrow(TypeError);
    });
  });

  describe('Backward Compatibility & Migration (decryptCredential)', () => {
    it('returns plaintext string as-is when unencrypted string payload is provided', async () => {
      const legacyPlainText = 'legacy_unencrypted_password_123';
      const result = await decryptCredential(legacyPlainText);
      expect(result).toBe(legacyPlainText);
    });

    it('handles empty/null/undefined gracefully', async () => {
      expect(await decryptCredential('')).toBe('');
      expect(await decryptCredential(null)).toBe('');
      expect(await decryptCredential(undefined)).toBe('');
    });

    it('decrypts JSON stringified EncryptedPayload object', async () => {
      const plainText = 'JSONStringifiedSecret';
      const encrypted = await encryptCredential(plainText);
      const jsonString = JSON.stringify(encrypted);

      const result = await decryptCredential(jsonString);
      expect(result).toBe(plainText);
    });

    it('handles non-encrypted objects by converting to string', async () => {
      const obj = { some: 'value' };
      const result = await decryptCredential(obj);
      expect(result).toBe('[object Object]');
    });
  });

  describe('Error Handling & Invalid Payloads', () => {
    it('throws error when decrypting corrupted ciphertext', async () => {
      const encrypted = await encryptCredential('validSecret');
      encrypted.data = 'CorruptedBase64Data!@#$';

      await expect(decryptCredential(encrypted)).rejects.toThrow();
    });

    it('throws error when decrypting payload with invalid format', async () => {
      const invalidPayload = { __encrypted: true, data: 123, iv: 'abc' };
      await expect(decryptCredential(invalidPayload)).rejects.toThrow('Invalid encrypted payload format');
    });
  });
});
