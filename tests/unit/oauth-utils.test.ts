import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOAuthRedirectUri, formatFirefoxLoopbackUri } from '~/lib/sync/oauth-utils';

describe('formatFirefoxLoopbackUri', () => {
  it('converts standard allizom.org URL to loopback URI without trailing slash', () => {
    const raw = 'https://abcdef123456.extensions.allizom.org/';
    expect(formatFirefoxLoopbackUri(raw)).toBe('http://127.0.0.1/mozoauth2/abcdef123456');
  });

  it('converts standard allizom.org URL without trailing slash to loopback URI', () => {
    const raw = 'https://abcdef123456.extensions.allizom.org';
    expect(formatFirefoxLoopbackUri(raw)).toBe('http://127.0.0.1/mozoauth2/abcdef123456');
  });

  it('handles http allizom.org URL correctly', () => {
    const raw = 'http://testsubdomain.extensions.allizom.org/';
    expect(formatFirefoxLoopbackUri(raw)).toBe('http://127.0.0.1/mozoauth2/testsubdomain');
  });

  it('strips trailing slashes from already-formatted loopback URI', () => {
    const raw = 'http://127.0.0.1/mozoauth2/abcdef123456/';
    expect(formatFirefoxLoopbackUri(raw)).toBe('http://127.0.0.1/mozoauth2/abcdef123456');
  });

  it('returns already-formatted loopback URI as-is when there is no trailing slash', () => {
    const raw = 'http://127.0.0.1/mozoauth2/abcdef123456';
    expect(formatFirefoxLoopbackUri(raw)).toBe('http://127.0.0.1/mozoauth2/abcdef123456');
  });

  it('returns non-allizom URLs unchanged', () => {
    expect(formatFirefoxLoopbackUri('https://example.chromiumapp.org/')).toBe('https://example.chromiumapp.org/');
    expect(formatFirefoxLoopbackUri('https://custom-domain.com/oauth')).toBe('https://custom-domain.com/oauth');
  });

  it('returns empty string for falsy or invalid inputs', () => {
    expect(formatFirefoxLoopbackUri('')).toBe('');
    expect(formatFirefoxLoopbackUri(null as unknown as string)).toBe('');
    expect(formatFirefoxLoopbackUri(undefined as unknown as string)).toBe('');
  });
});

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

  describe('Firefox environment', () => {
    const originalFirefox = import.meta.env.FIREFOX;

    beforeEach(() => {
      (import.meta.env as Record<string, unknown>).FIREFOX = true;
    });

    afterEach(() => {
      (import.meta.env as Record<string, unknown>).FIREFOX = originalFirefox;
    });

    it('formats redirect URI as loopback for Google Drive in Firefox', () => {
      vi.stubGlobal('__CHROME_EXTENSION_ID__', 'test-chrome-id');
      const mockGetRedirectURL = vi.fn().mockReturnValue('https://sha1hash.extensions.allizom.org/');
      vi.stubGlobal('browser', {
        identity: {
          getRedirectURL: mockGetRedirectURL,
        },
      });

      const uri = getOAuthRedirectUri('google-drive');
      expect(uri).toBe('http://127.0.0.1/mozoauth2/sha1hash');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    });

    it('formats redirect URI as loopback when provider is not specified in Firefox', () => {
      const mockGetRedirectURL = vi.fn().mockReturnValue('https://sha1hash.extensions.allizom.org/');
      vi.stubGlobal('browser', {
        identity: {
          getRedirectURL: mockGetRedirectURL,
        },
      });

      const uri = getOAuthRedirectUri();
      expect(uri).toBe('http://127.0.0.1/mozoauth2/sha1hash');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    });

    it('retains allizom.org URL for Dropbox in Firefox to prevent regression', () => {
      const mockGetRedirectURL = vi.fn().mockReturnValue('https://sha1hash.extensions.allizom.org/');
      vi.stubGlobal('browser', {
        identity: {
          getRedirectURL: mockGetRedirectURL,
        },
      });

      const uri = getOAuthRedirectUri('dropbox');
      expect(uri).toBe('https://sha1hash.extensions.allizom.org/');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    });

    it('retains allizom.org URL for OneDrive in Firefox to prevent regression', () => {
      const mockGetRedirectURL = vi.fn().mockReturnValue('https://sha1hash.extensions.allizom.org/');
      vi.stubGlobal('browser', {
        identity: {
          getRedirectURL: mockGetRedirectURL,
        },
      });

      const uri = getOAuthRedirectUri('onedrive');
      expect(uri).toBe('https://sha1hash.extensions.allizom.org/');
      expect(mockGetRedirectURL).toHaveBeenCalled();
    });
  });

  it('returns empty string when identity API is unavailable', () => {
    const uri = getOAuthRedirectUri();
    expect(uri).toBe('');
  });
});

