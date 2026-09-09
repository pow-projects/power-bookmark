import { describe, it, expect } from 'vitest';
import {
  buildArchiveFileName,
  detectArchiveFormat,
  resolveArchiveConflict,
  mergeArchiveIndex,
  emptyArchiveIndex,
  TOMBSTONE_TTL_MS,
  ARCHIVES_FOLDER,
  ARCHIVE_INDEX_FILE,
  type ArchiveIndexEntry
} from '../../src/lib/archive/archive-index';

function entry(over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
  return {
    syncId: 'sync-1',
    bookmarkId: 'bk-1',
    url: 'https://example.com',
    title: 'Example',
    fileName: 'sync-1.html',
    fileSize: 100,
    format: 'raw',
    archivedAt: 1000,
    ...over
  };
}

describe('buildArchiveFileName', () => {
  it('UUID → "UUID.html" (순수 syncId 고유 키)', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(buildArchiveFileName(id)).toBe(`${id}.html`);
  });

  it('비ASCII 입력도 toSafeAsciiFilename으로 정제된다', () => {
    const name = buildArchiveFileName('가나다라');
    // After sanitization only ASCII remains and .html extension is appended
    expect(name.endsWith('.html')).toBe(true);
    expect(/[^\x20-\x7E]/.test(name)).toBe(false);
  });
});

describe('detectArchiveFormat', () => {
  it('gzip 로더(DecompressionStream + const p=) → gzip', async () => {
    const blob = new Blob(['<html>DecompressionStream const p="abc";</html>'], { type: 'text/html' });
    expect(await detectArchiveFormat(blob)).toBe('gzip');
  });

  it('일반 HTML → raw', async () => {
    const blob = new Blob(['<html><body>hi</body></html>'], { type: 'text/html' });
    expect(await detectArchiveFormat(blob)).toBe('raw');
  });
});

describe('resolveArchiveConflict', () => {
  const local = entry({ archivedAt: 1000 });
  const cloud = entry({ archivedAt: 2000 });

  it('archivedAt 큰 쪽이 승자', () => {
    expect(resolveArchiveConflict(local, cloud).winner).toBe(cloud);
    expect(resolveArchiveConflict(cloud, local).winner).toBe(cloud);
    expect(resolveArchiveConflict(local, cloud).isConflict).toBe(false);
  });

  it('동점은 cloud 승(결정적 폴백)', () => {
    const c = entry({ archivedAt: 1000 });
    const r = resolveArchiveConflict(local, c);
    expect(r.winner).toBe(c);
    expect(r.isConflict).toBe(false);
  });

  it('동점 + fileSize 상이 → isConflict=true', () => {
    const c = entry({ archivedAt: 1000, fileSize: 999 });
    const r = resolveArchiveConflict(local, c);
    expect(r.winner).toBe(c);
    expect(r.isConflict).toBe(true);
  });
});

describe('mergeArchiveIndex', () => {
  it('LWW 병합 — 동일 syncId는 단일 항목 유지, 최신 archivedAt 승', () => {
    const local = [entry({ syncId: 'a', archivedAt: 100 })];
    const cloud = [entry({ syncId: 'a', archivedAt: 200 })];
    const merged = mergeArchiveIndex(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].archivedAt).toBe(200);
  });

  it('서로 다른 syncId는 모두 유지', () => {
    const local = [entry({ syncId: 'a' })];
    const cloud = [entry({ syncId: 'b' })];
    expect(mergeArchiveIndex(local, cloud)).toHaveLength(2);
  });

  it('유효 tombstone(TTL 내)은 해당 syncId 항목을 제거', () => {
    const now = Date.now();
    const local = [entry({ syncId: 'a', deleted: true, deletedAt: now })];
    const cloud = [entry({ syncId: 'a', archivedAt: 100 })];
    expect(mergeArchiveIndex(local, cloud, now)).toHaveLength(0);
  });

  it('TTL 초과 tombstone은 무시하고 일반 항목으로 유지', () => {
    const now = Date.now();
    const stale = entry({ syncId: 'a', deleted: true, deletedAt: now - TOMBSTONE_TTL_MS - 1000 });
    const merged = mergeArchiveIndex([stale], [], now);
    expect(merged).toHaveLength(1);
    expect(merged[0].deleted).toBeUndefined();
    expect(merged[0].deletedAt).toBeUndefined();
  });

  it('emptyArchiveIndex는 version 1 + 빈 entries', () => {
    const idx = emptyArchiveIndex(1234);
    expect(idx).toEqual({ version: 1, entries: [], updatedAt: 1234 });
  });

  it('경로 상수는 archives/ 와 index.json', () => {
    expect(ARCHIVES_FOLDER).toBe('archives');
    expect(ARCHIVE_INDEX_FILE).toBe('index.json');
  });
});
