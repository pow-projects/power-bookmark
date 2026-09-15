import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { tick } from 'svelte';

const { mockData, dbMock } = vi.hoisted(() => {
  const data = {
    bookmarks: [] as any[],
    archivedPages: [] as any[],
    settings: {} as Record<string, any>,
    syncState: [] as any[]
  };
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => [...data.bookmarks]),
      get: vi.fn(async (id: number) => data.bookmarks.find((b) => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex((b) => b.id === id);
        if (idx !== -1) {
          data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
        }
      }),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          first: async () => undefined,
          delete: async () => {}
        }))
      })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => [...data.archivedPages]),
      where: vi.fn(() => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.archivedPages.find((a) => a.bookmarkId === val),
          delete: async () => {}
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) =>
        data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined
      ),
      put: vi.fn(async (item: { key: string; value: any }) => {
        data.settings[item.key] = item.value;
      })
    },
    syncState: {
      toArray: vi.fn(async () => [...data.syncState]),
      orderBy: () => ({
        last: async () => data.syncState[data.syncState.length - 1] || null
      }),
      put: vi.fn(async (record: any) => {
        data.syncState.push(record);
      })
    }
  };
  return { mockData: data, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: vi.fn(async () => false),
  analyzeContent: vi.fn(async () => ({}))
}));

vi.mock('../../src/lib/archive/page-capture', () => ({
  archiveBookmark: vi.fn(async () => {}),
  decompressArchiveHtml: vi.fn(async (blob: Blob) => blob)
}));

const storageListeners: any[] = [];
const runtimeListeners: any[] = [];

vi.stubGlobal('browser', {
  i18n: {
    getMessage: vi.fn((key: string) => key)
  },
  runtime: {
    sendMessage: vi.fn(async (msg: any) => {
      for (const listener of runtimeListeners) {
        listener(msg, {}, () => {});
      }
      return { ok: true };
    }),
    onMessage: {
      addListener: vi.fn((cb: any) => {
        runtimeListeners.push(cb);
      }),
      removeListener: vi.fn((cb: any) => {
        const idx = runtimeListeners.indexOf(cb);
        if (idx !== -1) runtimeListeners.splice(idx, 1);
      })
    }
  },
  storage: {
    onChanged: {
      addListener: vi.fn((cb: any) => {
        storageListeners.push(cb);
      }),
      removeListener: vi.fn((cb: any) => {
        const idx = storageListeners.indexOf(cb);
        if (idx !== -1) storageListeners.splice(idx, 1);
      })
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async (obj: any) => {
        const changes: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { newValue: v };
        }
        for (const cb of storageListeners) {
          cb(changes, 'local');
        }
      }),
      remove: vi.fn(async () => {})
    }
  },
  bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: {
    query: vi.fn(async () => [])
  }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';

describe('Bookmark List Auto-Refresh on Sync & Bookmark Updates', () => {
  let target: HTMLElement;
  let component: any;

  beforeEach(async () => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.appendChild(target);
    mockData.bookmarks = [
      {
        id: 1,
        syncId: 'sync-1',
        title: 'Initial Bookmark',
        url: 'https://initial.example.com',
        folderPath: 'Bookmarks bar',
        createdAt: 1000,
        modifiedAt: 1000
      }
    ];
    component = new BookmarkList({ target });
    await tick();
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(() => {
    if (component) {
      component.$destroy();
    }
  });

  it('renders initial bookmark on mount', () => {
    expect(target.textContent).toContain('Initial Bookmark');
    expect(target.textContent).not.toContain('Synced Bookmark');
  });

  it('updates screen automatically when sync-resolved custom event is dispatched', async () => {
    // Simulate sync adding a new bookmark into DB
    mockData.bookmarks.push({
      id: 2,
      syncId: 'sync-2',
      title: 'Synced Bookmark from Cloud',
      url: 'https://cloud.example.com',
      folderPath: 'Bookmarks bar',
      createdAt: 2000,
      modifiedAt: 2000
    });

    // Dispatch sync-resolved event
    document.dispatchEvent(new CustomEvent('sync-resolved'));

    // Wait for debounced reload
    await new Promise((r) => setTimeout(r, 150));
    await tick();

    // Verify screen updated without manual reload
    expect(target.textContent).toContain('Synced Bookmark from Cloud');
  });

  it('updates screen automatically when bookmarks-updated custom event is dispatched', async () => {
    mockData.bookmarks.push({
      id: 3,
      syncId: 'sync-3',
      title: 'Browser Created Bookmark',
      url: 'https://browser.example.com',
      folderPath: 'Bookmarks bar',
      createdAt: 3000,
      modifiedAt: 3000
    });

    document.dispatchEvent(new CustomEvent('bookmarks-updated'));

    await new Promise((r) => setTimeout(r, 150));
    await tick();

    expect(target.textContent).toContain('Browser Created Bookmark');
  });

  it('updates screen automatically when browser.storage sync_last_completed changes', async () => {
    mockData.bookmarks.push({
      id: 4,
      syncId: 'sync-4',
      title: 'Background Synced Bookmark',
      url: 'https://bg.example.com',
      folderPath: 'Bookmarks bar',
      createdAt: 4000,
      modifiedAt: 4000
    });

    // Simulate storage change notification from background sync
    await browser.storage.local.set({ sync_last_completed: Date.now() });

    await new Promise((r) => setTimeout(r, 150));
    await tick();

    expect(target.textContent).toContain('Background Synced Bookmark');
  });

  it('updates screen automatically when browser.runtime message BOOKMARKS_UPDATED is received', async () => {
    mockData.bookmarks.push({
      id: 5,
      syncId: 'sync-5',
      title: 'Message Synced Bookmark',
      url: 'https://msg.example.com',
      folderPath: 'Bookmarks bar',
      createdAt: 5000,
      modifiedAt: 5000
    });

    // Simulate background runtime message broadcast
    await browser.runtime.sendMessage({ type: 'BOOKMARKS_UPDATED' });

    await new Promise((r) => setTimeout(r, 150));
    await tick();

    expect(target.textContent).toContain('Message Synced Bookmark');
  });
});
