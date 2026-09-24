import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOAuthRedirectUri } from '~/lib/sync/oauth-utils';

describe('getOAuthRedirectUri', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to browser.identity.getRedirectURL in dev environment when no constant is set', () => {
    const mockGetRedirectURL = vi.fn().mockReturnValue('https://dummy-dev-id.chromiumapp.org/');
    vi.stubGlobal('browser', {
      identity: {
        getRedirectURL: mockGetRedirectURL,
      },
    });

    const uri = getOAuthRedirectUri();
    expect(uri).toBe('https://dummy-dev-id.chromiumapp.org/');
    expect(mockGetRedirectURL).toHaveBeenCalled();
  });

  it('falls back to chrome.identity.getRedirectURL when browser is undefined', () => {
    const mockGetRedirectURL = vi.fn().mockReturnValue('https://chrome-dev-id.chromiumapp.org/');
    vi.stubGlobal('chrome', {
      identity: {
        getRedirectURL: mockGetRedirectURL,
      },
    });

    const uri = getOAuthRedirectUri();
    expect(uri).toBe('https://chrome-dev-id.chromiumapp.org/');
    expect(mockGetRedirectURL).toHaveBeenCalled();
  });

  it('returns Chrome fixed redirect URI when in production, __CHROME_EXTENSION_ID__ is set, and not Firefox', () => {
    vi.stubGlobal('__CHROME_EXTENSION_ID__', 'test-chrome-id');
    const originalProd = import.meta.env.PROD;
    (import.meta.env as Record<string, unknown>).PROD = true;

    try {
      const uri = getOAuthRedirectUri();
      expect(uri).toBe('https://test-chrome-id.chromiumapp.org/');
    } finally {
      (import.meta.env as Record<string, unknown>).PROD = originalProd;
    }
  });

  it('falls back to identity API in development mode even if __CHROME_EXTENSION_ID__ is set', () => {
    vi.stubGlobal('__CHROME_EXTENSION_ID__', 'test-chrome-id');
    const mockGetRedirectURL = vi.fn().mockReturnValue('https://dev-ext-id.chromiumapp.org/');
    vi.stubGlobal('browser', {
      identity: {
        getRedirectURL: mockGetRedirectURL,
      },
    });

    const originalProd = import.meta.env.PROD;
    (import.meta.env as Record<string, unknown>).PROD = false;

    try {
      const uri = getOAuthRedirectUri();
      expect(uri).toBe('https://dev-ext-id.chromiumapp.org/');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    } finally {
      (import.meta.env as Record<string, unknown>).PROD = originalProd;
    }
  });

  it('delegates to browser.identity.getRedirectURL in Firefox even if chrome ID is present', () => {
    vi.stubGlobal('__CHROME_EXTENSION_ID__', 'test-chrome-id');
    const mockGetRedirectURL = vi.fn().mockReturnValue('https://sha1hash.extensions.allizom.org/');
    vi.stubGlobal('browser', {
      identity: {
        getRedirectURL: mockGetRedirectURL,
      },
    });

    // Mock import.meta.env.FIREFOX
    const originalFirefox = import.meta.env.FIREFOX;
    (import.meta.env as Record<string, unknown>).FIREFOX = true;

    try {
      const uri = getOAuthRedirectUri();
      expect(uri).toBe('https://sha1hash.extensions.allizom.org/');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    } finally {
      (import.meta.env as Record<string, unknown>).FIREFOX = originalFirefox;
    }
  });

  it('returns empty string when identity API is unavailable', () => {
    const uri = getOAuthRedirectUri();
    expect(uri).toBe('');
  });
});
