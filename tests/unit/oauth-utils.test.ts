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

  it('returns empty string when identity API is unavailable', () => {
    const uri = getOAuthRedirectUri();
    expect(uri).toBe('');
  });
});
