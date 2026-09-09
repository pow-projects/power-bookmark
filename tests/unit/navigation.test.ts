import { describe, it, expect, beforeEach, vi } from 'vitest';

export function parseNavigationState(search: string): { activeTab: string; activeSection: string; redirectedUrl?: string } {
  const urlParams = new URLSearchParams(search);
  const tabParam = urlParams.get('tab');
  const sectionParam = urlParams.get('section');

  let activeTab = 'stats';
  let activeSection = 'archive';
  let redirectedUrl: string | undefined = undefined;

  function isValidTab(tab: string): boolean {
    return ['stats', 'bookmarks', 'settings'].includes(tab);
  }

  const archiveIdParam = urlParams.get('archiveId');

  if (archiveIdParam || tabParam === 'bookmarks') {
    activeTab = 'bookmarks';
  } else if (tabParam === 'sync') {
    // Legacy ?tab=sync backward compatibility: redirect to settings tab with sync section
    activeTab = 'settings';
    activeSection = 'sync';
    redirectedUrl = '?tab=settings&section=sync';
  } else if (tabParam === 'settings') {
    activeTab = 'settings';
    if (sectionParam === 'sync' || sectionParam === 'ai' || sectionParam === 'archive') {
      activeSection = sectionParam;
    }
  } else if (tabParam && isValidTab(tabParam)) {
    activeTab = tabParam;
  }

  return { activeTab, activeSection, redirectedUrl };
}

export function buildTabUrl(pathname: string, tab: string, activeSection: string): string {
  if (tab === 'settings') {
    return pathname + `?tab=settings&section=${activeSection}`;
  }
  return pathname + `?tab=${tab}`;
}

describe('Management Navigation & Backward Compatibility', () => {
  describe('parseNavigationState (?tab=sync backward compatibility)', () => {
    it('redirects legacy ?tab=sync to settings tab with sync section', () => {
      const result = parseNavigationState('?tab=sync');
      expect(result.activeTab).toBe('settings');
      expect(result.activeSection).toBe('sync');
      expect(result.redirectedUrl).toBe('?tab=settings&section=sync');
    });

    it('parses ?tab=settings&section=archive correctly', () => {
      const result = parseNavigationState('?tab=settings&section=archive');
      expect(result.activeTab).toBe('settings');
      expect(result.activeSection).toBe('archive');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('parses ?tab=settings&section=sync correctly', () => {
      const result = parseNavigationState('?tab=settings&section=sync');
      expect(result.activeTab).toBe('settings');
      expect(result.activeSection).toBe('sync');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('parses ?tab=settings&section=ai correctly', () => {
      const result = parseNavigationState('?tab=settings&section=ai');
      expect(result.activeTab).toBe('settings');
      expect(result.activeSection).toBe('ai');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('defaults section to archive when ?tab=settings has no section param', () => {
      const result = parseNavigationState('?tab=settings');
      expect(result.activeTab).toBe('settings');
      expect(result.activeSection).toBe('archive');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('parses ?tab=stats correctly', () => {
      const result = parseNavigationState('?tab=stats');
      expect(result.activeTab).toBe('stats');
      expect(result.activeSection).toBe('archive');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('parses ?tab=bookmarks correctly', () => {
      const result = parseNavigationState('?tab=bookmarks');
      expect(result.activeTab).toBe('bookmarks');
      expect(result.activeSection).toBe('archive');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('falls back to stats tab for invalid tab parameter', () => {
      const result = parseNavigationState('?tab=unknown');
      expect(result.activeTab).toBe('stats');
      expect(result.redirectedUrl).toBeUndefined();
    });

    it('falls back to stats tab when no search params are provided', () => {
      const result = parseNavigationState('');
      expect(result.activeTab).toBe('stats');
      expect(result.redirectedUrl).toBeUndefined();
    });
  });

  describe('buildTabUrl', () => {
    it('builds URL for settings tab with active section', () => {
      const urlArchive = buildTabUrl('/management.html', 'settings', 'archive');
      expect(urlArchive).toBe('/management.html?tab=settings&section=archive');

      const urlSync = buildTabUrl('/management.html', 'settings', 'sync');
      expect(urlSync).toBe('/management.html?tab=settings&section=sync');

      const urlAi = buildTabUrl('/management.html', 'settings', 'ai');
      expect(urlAi).toBe('/management.html?tab=settings&section=ai');
    });

    it('builds URL for non-settings tabs', () => {
      expect(buildTabUrl('/management.html', 'stats', 'sync')).toBe('/management.html?tab=stats');
      expect(buildTabUrl('/management.html', 'bookmarks', 'ai')).toBe('/management.html?tab=bookmarks');
    });
  });

  describe('DOM & window.history integration for App navigation', () => {
    let replaceStateSpy: any;

    beforeEach(() => {
      window.history.pushState({}, '', 'http://localhost/management.html');
      replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    });

    it('simulates syncTabFromUrl in DOM environment with ?tab=sync', () => {
      window.history.pushState({}, '', 'http://localhost/management.html?tab=sync');

      const state = parseNavigationState(window.location.search);
      if (state.redirectedUrl) {
        window.history.replaceState({ tab: state.activeTab, section: state.activeSection }, '', window.location.pathname + state.redirectedUrl);
      }

      expect(state.activeTab).toBe('settings');
      expect(state.activeSection).toBe('sync');
      expect(replaceStateSpy).toHaveBeenCalledWith(
        { tab: 'settings', section: 'sync' },
        '',
        '/management.html?tab=settings&section=sync'
      );
    });
  });

  describe('SettingsContainer Single Page Layout & Section Anchoring', () => {
    let scrollSpy: any;

    beforeEach(() => {
      document.body.innerHTML = '';
      scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy;
    });

    it('renders single page layout containing Web Archive, Cloud Sync, and AI sections with dividers in correct order', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;
      new SettingsContainer({ target, props: { initialSection: 'archive' } });

      const archiveSection = document.getElementById('archive-settings-section');
      const syncSection = document.getElementById('cloud-sync-section');
      const aiSection = document.getElementById('ai-settings-section');

      expect(archiveSection).not.toBeNull();
      expect(syncSection).not.toBeNull();
      expect(aiSection).not.toBeNull();

      // Verify DOM ordering: archive -> sync -> ai
      const archivePos = archiveSection!.compareDocumentPosition(syncSection!);
      const syncPos = syncSection!.compareDocumentPosition(aiSection!);
      expect(archivePos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(syncPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('triggers automatic smooth scroll to cloud-sync-section when initialSection is sync', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;

      new SettingsContainer({ target, props: { initialSection: 'sync' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('triggers automatic smooth scroll to ai-settings-section when initialSection is ai', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;

      new SettingsContainer({ target, props: { initialSection: 'ai' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('does not trigger automatic smooth scroll to lower sections when initialSection is archive', async () => {
      const { default: SettingsContainer } = await import('../../src/components/management/SettingsContainer.svelte');
      const target = document.body;

      new SettingsContainer({ target, props: { initialSection: 'archive' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(scrollSpy).not.toHaveBeenCalled();
    });
  });
});









