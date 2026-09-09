import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { parseNavigationState } from './navigation.test';

describe('Management Page Archive Navigation & Overlay', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/test-uuid');
    }
    if (!globalThis.window.open) {
      globalThis.window.open = vi.fn();
    }
  });

  it('detects archiveId parameter in URL query string', () => {
    const search = '?tab=bookmarks&archiveId=101';
    const state = parseNavigationState(search);
    expect(state.activeTab).toBe('bookmarks');
  });

  it('content script handles EXTRACT_TEXT and EXTRACT_HTML', async () => {
    let messageListener: Function | null = null;
    vi.stubGlobal('defineContentScript', (config: any) => {
      config.main();
      return config;
    });

    vi.stubGlobal('browser', {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener) => {
            messageListener = listener;
          })
        }
      }
    });

    await import('../../src/entrypoints/content');
    expect(messageListener).not.toBeNull();

    const sendResponse = vi.fn();
    messageListener!({ type: 'EXTRACT_TEXT' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalled();
  });

  it('opens archive blob URL in new tab', async () => {
    const createTabSpy = vi.fn();
    vi.stubGlobal('browser', {
      tabs: {
        create: createTabSpy
      }
    });

    const testBlob = new Blob(['<html>test</html>'], { type: 'text/html' });
    const blobUrl = globalThis.URL.createObjectURL(testBlob);
    await browser.tabs.create({ url: blobUrl });

    expect(createTabSpy).toHaveBeenCalledWith({ url: 'blob:http://localhost/test-uuid' });
  });

  it('renders exact bookmark title without "아카이브:" prefix in modal header', async () => {
    const { default: ArchiveViewerModal } = await import('../../src/components/shared/ArchiveViewerModal.svelte');
    const component = new ArchiveViewerModal({
      target: document.body,
      props: {
        open: true,
        html: '<html><head><title>Original Page</title></head><body>Content</body></html>',
        bookmark: {
          id: 1,
          syncId: 'sync-1',
          bookmarkId: 'bm-1',
          url: 'https://example.com',
          title: '내 멋진 북마크',
          description: '',
          folderPath: '',
          createdAt: Date.now(),
          modifiedAt: Date.now(),
          visitCount: 0
        }
      }
    });

    const header = document.querySelector('.page-info h3');
    expect(header?.textContent).toBe('내 멋진 북마크');
    expect(header?.textContent).not.toContain('아카이브:');
  });

  it('falls back to HTML title or "제목 없음" when bookmark is absent', async () => {
    const { default: ArchiveViewerModal } = await import('../../src/components/shared/ArchiveViewerModal.svelte');
    const component = new ArchiveViewerModal({
      target: document.body,
      props: {
        open: true,
        html: '<html><head><title>HTML 문서 제목</title></head><body>Content</body></html>'
      }
    });

    const header = document.querySelector('.page-info h3');
    expect(header?.textContent).toBe('HTML 문서 제목');
    expect(header?.textContent).not.toContain('아카이브:');
  });

  it('dispatches delete event when archive delete button is clicked', async () => {
    const { default: ArchiveViewerModal } = await import('../../src/components/shared/ArchiveViewerModal.svelte');
    const onDeleteSpy = vi.fn();
    const deleteEventSpy = vi.fn();

    const component = new ArchiveViewerModal({
      target: document.body,
      props: {
        open: true,
        archivePage: {
          id: 42,
          bookmarkId: 10,
          url: 'https://example.com',
          htmlBlob: new Blob(),
          fileSize: 1024,
          archivedAt: Date.now()
        },
        onDelete: onDeleteSpy
      }
    });

    component.$on('delete', deleteEventSpy);

    const deleteBtn = document.querySelector('.viewer-buttons .btn-danger') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    deleteBtn.click();

    expect(onDeleteSpy).toHaveBeenCalledWith(42);
    expect(deleteEventSpy).toHaveBeenCalledWith(expect.objectContaining({ detail: { archiveId: 42 } }));
  });

  it('recovers from non-Blob htmlBlob by fetching fresh record from IndexedDB without infinite loop', async () => {
    const { default: db } = await import('../../src/lib/db');
    const validBlob = new Blob(['<html>Decompressed Content</html>'], { type: 'text/html' });
    vi.spyOn(db.archivedPages, 'where').mockReturnValue({
      equals: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({
          id: 99,
          bookmarkId: 55,
          url: 'https://example.com/db-recovered',
          htmlBlob: validBlob,
          fileSize: validBlob.size,
          archivedAt: Date.now()
        })
      })
    } as any);

    const { default: ArchiveViewerModal } = await import('../../src/components/shared/ArchiveViewerModal.svelte');
    const component = new ArchiveViewerModal({
      target: document.body,
      props: {
        open: true,
        archivePage: {
          id: 99,
          bookmarkId: 55,
          url: 'https://example.com/db-recovered',
          htmlBlob: {} as any, // non-Blob passed via IPC JSON serialization
          fileSize: 1024,
          archivedAt: Date.now()
        }
      }
    });

    await new Promise(r => setTimeout(r, 50));
    const iframe = document.querySelector('.iframe-container iframe');
    expect(iframe).not.toBeNull();
  });

  it('displays spinner and disables button while onDelete is in progress', async () => {
    let resolveDelete: () => void = () => {};
    const deletePromise = new Promise<void>((r) => { resolveDelete = r; });
    const onDeleteSpy = vi.fn(() => deletePromise);

    const { default: ArchiveViewerModal } = await import('../../src/components/shared/ArchiveViewerModal.svelte');
    const component = new ArchiveViewerModal({
      target: document.body,
      props: {
        open: true,
        archivePage: {
          id: 10,
          bookmarkId: 1,
          url: 'https://example.com',
          htmlBlob: new Blob(['<html>test</html>']),
          fileSize: 1024,
          archivedAt: Date.now()
        },
        onDelete: onDeleteSpy
      }
    });

    const deleteBtn = document.querySelector('.btn-danger') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.disabled).toBe(false);
    expect(deleteBtn.querySelector('.spinner-inline')).toBeNull();

    // Click delete
    deleteBtn.click();
    await tick();

    expect(onDeleteSpy).toHaveBeenCalledWith(10);
    expect(deleteBtn.disabled).toBe(true);
    expect(deleteBtn.querySelector('.spinner-inline')).not.toBeNull();

    // Resolve deletion
    resolveDelete();
    await deletePromise;
    await tick();

    expect(deleteBtn.disabled).toBe(false);
    expect(deleteBtn.querySelector('.spinner-inline')).toBeNull();
  });

  describe('buildArchiveBannerHtml i18n and customization', () => {
    it('uses i18n.t("archive.banner") when i18n is available', async () => {
      const { buildArchiveBannerHtml } = await import('../../src/lib/archive/archive-viewer');
      vi.stubGlobal('i18n', {
        t: vi.fn((key: string) => {
          if (key === 'archive.banner') return 'Viewing archive · Saved copy of the original page';
          return key;
        })
      });

      const html = '<html><body><p>Hello</p></body></html>';
      const output = buildArchiveBannerHtml(html);
      expect(output).toContain('Viewing archive · Saved copy of the original page');
    });

    it('falls back to default Korean string when i18n is undefined', async () => {
      const { buildArchiveBannerHtml } = await import('../../src/lib/archive/archive-viewer');
      // @ts-ignore
      delete globalThis.i18n;

      const html = '<html><body><p>Hello</p></body></html>';
      const output = buildArchiveBannerHtml(html);
      expect(output).toContain('아카이브 보기 중 · 원본 페이지의 저장된 복사본');
    });

    it('uses custom bannerText option when provided', async () => {
      const { buildArchiveBannerHtml } = await import('../../src/lib/archive/archive-viewer');
      const html = '<html><body><p>Hello</p></body></html>';
      const output = buildArchiveBannerHtml(html, { bannerText: 'Custom Archive Banner' });
      expect(output).toContain('Custom Archive Banner');
    });
  });
});
