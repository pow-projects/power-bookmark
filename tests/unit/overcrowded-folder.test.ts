import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OVERCROWDED_FOLDER_THRESHOLD,
  NOTIFIED_OVERCROWDED_FOLDERS_KEY,
  findOvercrowdedFolders,
  getNotifiedOvercrowdedFolders,
  markOvercrowdedFolderNotified
} from '../../src/lib/bookmarks/overcrowded-folder';
import type { Bookmark } from '../../src/lib/db';
import type { FolderNode } from '../../src/lib/bookmarks/bookmark-manager';

const { settingsStore, dbMock } = vi.hoisted(() => {
  const store: Record<string, any> = {};
  const mock = {
    settings: {
      get: vi.fn(async (key: string) => (store[key] !== undefined ? { key, value: store[key] } : undefined)),
      put: vi.fn(async (item: { key: string; value: any }) => {
        store[item.key] = item.value;
      })
    }
  };
  return { settingsStore: store, dbMock: mock };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

describe('overcrowded-folder logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settingsStore)) {
      delete settingsStore[key];
    }
  });

  describe('threshold constant', () => {
    it('has threshold set to 50', () => {
      expect(OVERCROWDED_FOLDER_THRESHOLD).toBe(50);
      expect(NOTIFIED_OVERCROWDED_FOLDERS_KEY).toBe('notified_overcrowded_folders');
    });
  });

  describe('findOvercrowdedFolders', () => {
    it('returns empty array when bookmarks array is empty', () => {
      const result = findOvercrowdedFolders([]);
      expect(result).toEqual([]);
    });

    it('ignores bookmarks with count below threshold (< 50)', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 49 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/Tech',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const result = findOvercrowdedFolders(bookmarks);
      expect(result).toHaveLength(0);
    });

    it('detects folders with exactly 50 bookmarks (>= threshold)', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/Development',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const result = findOvercrowdedFolders(bookmarks);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        folderPath: 'Bookmarks bar/Development',
        folderName: 'Development',
        folderId: undefined,
        count: 50
      });
    });

    it('detects multiple overcrowded folders and sorts by count descending', () => {
      const folderA = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-a-${i}`,
        bookmarkId: `bm-a-${i}`,
        url: `https://a.com/${i}`,
        title: `A ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/FolderA',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const folderB = Array.from({ length: 80 }, (_, i) => ({
        id: i + 100,
        syncId: `sync-b-${i}`,
        bookmarkId: `bm-b-${i}`,
        url: `https://b.com/${i}`,
        title: `B ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/FolderB',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const result = findOvercrowdedFolders([...folderA, ...folderB]);
      expect(result).toHaveLength(2);
      expect(result[0].folderPath).toBe('Bookmarks bar/FolderB');
      expect(result[0].count).toBe(80);
      expect(result[1].folderPath).toBe('Bookmarks bar/FolderA');
      expect(result[1].count).toBe(60);
    });

    it('associates folderId when folder mapping matches folderPath', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 55 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/Work',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const folders: FolderNode[] = [
        {
          id: 'folder-work-123',
          title: 'Work',
          path: 'Bookmarks bar/Work',
          depth: 1,
          displayName: 'Work'
        }
      ];

      const result = findOvercrowdedFolders(bookmarks, [], folders);
      expect(result).toHaveLength(1);
      expect(result[0].folderId).toBe('folder-work-123');
      expect(result[0].folderName).toBe('Work');
    });

    it('filters out folders already present in notifiedFolders list by path', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 55 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/DismissedFolder',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const result = findOvercrowdedFolders(bookmarks, ['Bookmarks bar/DismissedFolder']);
      expect(result).toHaveLength(0);
    });

    it('filters out folders already present in notifiedFolders list by folderId', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 55 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: 'Bookmarks bar/DismissedFolder',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const folders: FolderNode[] = [
        {
          id: 'folder-dismissed-id',
          title: 'DismissedFolder',
          path: 'Bookmarks bar/DismissedFolder',
          depth: 1,
          displayName: 'DismissedFolder'
        }
      ];

      const result = findOvercrowdedFolders(bookmarks, ['folder-dismissed-id'], folders);
      expect(result).toHaveLength(0);
    });

    it('ignores uncategorized bookmarks with empty or whitespace folderPath', () => {
      const bookmarks: Bookmark[] = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        syncId: `sync-${i}`,
        bookmarkId: `bm-${i}`,
        url: `https://example.com/${i}`,
        title: `Bookmark ${i}`,
        description: '',
        folderPath: i % 2 === 0 ? '' : '   ',
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        visitCount: 0
      }));

      const result = findOvercrowdedFolders(bookmarks);
      expect(result).toHaveLength(0);
    });
  });

  describe('persistence in db.settings (1-time notification)', () => {
    it('returns empty array when nothing is stored in db.settings', async () => {
      const notified = await getNotifiedOvercrowdedFolders();
      expect(notified).toEqual([]);
    });

    it('returns stored notified folders from db.settings', async () => {
      settingsStore[NOTIFIED_OVERCROWDED_FOLDERS_KEY] = ['Bookmarks bar/OldFolder'];
      const notified = await getNotifiedOvercrowdedFolders();
      expect(notified).toEqual(['Bookmarks bar/OldFolder']);
    });

    it('marks folder path as notified and persists to db.settings', async () => {
      await markOvercrowdedFolderNotified('Bookmarks bar/Tech');
      expect(settingsStore[NOTIFIED_OVERCROWDED_FOLDERS_KEY]).toContain('Bookmarks bar/Tech');

      const retrieved = await getNotifiedOvercrowdedFolders();
      expect(retrieved).toContain('Bookmarks bar/Tech');
    });

    it('marks both folderPath and folderId as notified when folderId is provided', async () => {
      await markOvercrowdedFolderNotified('Bookmarks bar/Design', 'folder-design-456');
      expect(settingsStore[NOTIFIED_OVERCROWDED_FOLDERS_KEY]).toEqual(
        expect.arrayContaining(['Bookmarks bar/Design', 'folder-design-456'])
      );
    });

    it('is idempotent and prevents duplicate identifiers in db.settings', async () => {
      await markOvercrowdedFolderNotified('Bookmarks bar/Tech');
      await markOvercrowdedFolderNotified('Bookmarks bar/Tech');
      await markOvercrowdedFolderNotified('Bookmarks bar/Tech', 'tech-id');
      await markOvercrowdedFolderNotified('Bookmarks bar/Tech', 'tech-id');

      const list = settingsStore[NOTIFIED_OVERCROWDED_FOLDERS_KEY];
      expect(list.filter((x: string) => x === 'Bookmarks bar/Tech')).toHaveLength(1);
      expect(list.filter((x: string) => x === 'tech-id')).toHaveLength(1);
    });
  });
});
