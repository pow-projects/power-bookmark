import { describe, it, expect, vi, beforeEach } from 'vitest';
import PopupOptionsCard from '../../src/components/popup/PopupOptionsCard.svelte';
import type { SyncStatusState } from '../../src/lib/sync/sync-status-store';

describe('PopupOptionsCard Sync Status Badge', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders connected badge when WebDAV is connected', () => {
    const syncState: SyncStatusState = {
      provider: 'webdav',
      lastSyncTime: 1700000000000,
      isSyncing: false,
      isConnected: true,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const badge = target.querySelector('.sync-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('is-connected')).toBe(true);
    expect(badge?.textContent).toContain('WebDAV');
  });

  it('renders last sync meta with both date and time when connected and lastSyncTime is present', () => {
    const syncDate = new Date(2026, 8, 20, 16, 45); // 2026.09.20 16:45
    const syncState: SyncStatusState = {
      provider: 'google-drive',
      lastSyncTime: syncDate.getTime(),
      isSyncing: false,
      isConnected: true,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const meta = target.querySelector('.last-sync-text');
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain('2026.09.20 16:45');
  });

  it('renders disconnected badge (is-error) when WebDAV server is offline / not connected', () => {
    const syncState: SyncStatusState = {
      provider: 'webdav',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const badge = target.querySelector('.sync-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('is-connected')).toBe(false);
    expect(badge?.classList.contains('is-error')).toBe(true);
    expect(badge?.tagName.toLowerCase()).toBe('button');
  });

  it('calls onOpenSyncSettings when error badge is clicked', () => {
    const onOpenSyncSettings = vi.fn();
    const syncState: SyncStatusState = {
      provider: 'webdav',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {},
        onOpenSyncSettings
      }
    });

    const badge = target.querySelector('.sync-badge.is-error') as HTMLButtonElement;
    expect(badge).not.toBeNull();
    badge.click();
    expect(onOpenSyncSettings).toHaveBeenCalledTimes(1);
  });

  it('renders syncing badge when sync is in progress', () => {
    const syncState: SyncStatusState = {
      provider: 'webdav',
      lastSyncTime: 1700000000000,
      isSyncing: true,
      isConnected: true,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const badge = target.querySelector('.sync-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('is-syncing')).toBe(true);
  });

  it('renders unconfigured disconnected badge when provider is none', () => {
    const syncState: SyncStatusState = {
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const badge = target.querySelector('.sync-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('is-disconnected')).toBe(true);
    expect(badge?.classList.contains('is-error')).toBe(false);
  });
});

describe('PopupOptionsCard Section Titles and Settings Navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders interactive header-title buttons with icon-swap animation containers', () => {
    const syncState: SyncStatusState = {
      provider: 'google-drive',
      lastSyncTime: 1700000000000,
      isSyncing: false,
      isConnected: true,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'openai',
        autoSummarize: true,
        autoTags: true,
        autoFolder: true,
        aiConfigured: true,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {}
      }
    });

    const titleButtons = target.querySelectorAll('button.header-title-btn');
    expect(titleButtons.length).toBe(2);

    // Sync section title button
    const syncTitleBtn = titleButtons[0] as HTMLButtonElement;
    expect(syncTitleBtn.textContent).toMatch(/클라우드 동기화|Cloud Sync/);
    const syncIconSwap = syncTitleBtn.querySelector('.icon-swap');
    expect(syncIconSwap).not.toBeNull();
    const syncDefaultIcon = syncIconSwap?.querySelector('.icon-default');
    const syncHoverIcon = syncIconSwap?.querySelector('.icon-hover');
    expect(syncDefaultIcon).not.toBeNull();
    expect(syncHoverIcon).not.toBeNull();

    // AI section title button
    const aiTitleBtn = titleButtons[1] as HTMLButtonElement;
    expect(aiTitleBtn.textContent).toMatch(/AI 자동 처리|AI Auto Processing/);
    const aiIconSwap = aiTitleBtn.querySelector('.icon-swap');
    expect(aiIconSwap).not.toBeNull();
    const aiDefaultIcon = aiIconSwap?.querySelector('.icon-default');
    const aiHoverIcon = aiIconSwap?.querySelector('.icon-hover');
    expect(aiDefaultIcon).not.toBeNull();
    expect(aiHoverIcon).not.toBeNull();
  });

  it('calls onOpenSyncSettings when sync section title is clicked', () => {
    const onOpenSyncSettings = vi.fn();
    const syncState: SyncStatusState = {
      provider: 'webdav',
      lastSyncTime: 1700000000000,
      isSyncing: false,
      isConnected: true,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'none',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: false,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {},
        onOpenSyncSettings
      }
    });

    const syncTitleBtn = target.querySelector('.sync-section button.header-title-btn') as HTMLButtonElement;
    expect(syncTitleBtn).not.toBeNull();
    syncTitleBtn.click();
    expect(onOpenSyncSettings).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenAiSettings when AI section title is clicked', () => {
    const onOpenAiSettings = vi.fn();
    const syncState: SyncStatusState = {
      provider: 'none',
      lastSyncTime: null,
      isSyncing: false,
      isConnected: false,
      error: null
    };

    const target = document.createElement('div');
    document.body.appendChild(target);

    new PopupOptionsCard({
      target,
      props: {
        syncState,
        aiProvider: 'openai',
        autoSummarize: false,
        autoTags: false,
        autoFolder: false,
        aiConfigured: true,
        onToggleSummarize: () => {},
        onToggleTags: () => {},
        onToggleFolder: () => {},
        onOpenAiSettings
      }
    });

    const aiTitleBtn = target.querySelector('.ai-options-section button.header-title-btn') as HTMLButtonElement;
    expect(aiTitleBtn).not.toBeNull();
    aiTitleBtn.click();
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });
});

