import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isIncognitoContext, isIncognitoTab } from '../../src/lib/utils/incognito';

describe('Incognito Utility Helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isIncognitoContext()', () => {
    it('returns true when chrome.extension.inIncognitoContext is true', () => {
      vi.stubGlobal('chrome', {
        extension: {
          inIncognitoContext: true
        }
      });
      expect(isIncognitoContext()).toBe(true);
    });

    it('returns true when browser.extension.inIncognitoContext is true', () => {
      vi.stubGlobal('browser', {
        extension: {
          inIncognitoContext: true
        }
      });
      expect(isIncognitoContext()).toBe(true);
    });

    it('returns false when inIncognitoContext is false', () => {
      vi.stubGlobal('chrome', {
        extension: {
          inIncognitoContext: false
        }
      });
      expect(isIncognitoContext()).toBe(false);
    });

    it('returns false when extension API is undefined', () => {
      vi.stubGlobal('chrome', undefined);
      vi.stubGlobal('browser', undefined);
      expect(isIncognitoContext()).toBe(false);
    });
  });

  describe('isIncognitoTab()', () => {
    it('returns true when tab.incognito is true', () => {
      expect(isIncognitoTab({ id: 1, incognito: true } as any)).toBe(true);
    });

    it('returns false when tab.incognito is false or undefined', () => {
      expect(isIncognitoTab({ id: 1, incognito: false } as any)).toBe(false);
      expect(isIncognitoTab({ id: 1 } as any)).toBe(false);
      expect(isIncognitoTab(null)).toBe(false);
      expect(isIncognitoTab(undefined)).toBe(false);
    });
  });
});
