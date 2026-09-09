import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportAsHtml, exportAsJson, exportAsCsv, downloadFile, toSafeAsciiFilename } from '../../src/lib/bookmarks/export-manager';
import db from '../../src/lib/db';

vi.mock('../../src/lib/db', () => {
  const mockDb = {
    bookmarks: {
      toArray: vi.fn()
    }
  };
  return {
    db: mockDb,
    default: mockDb
  };
});

describe('Export Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export bookmarks in Netscape HTML format', async () => {
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      {
        url: 'https://example.com',
        title: 'Example',
        createdAt: 1600000000000,
        modifiedAt: 1600000000000,
        description: 'Desc'
      }
    ] as any);

    const html = await exportAsHtml();
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('HREF="https://example.com"');
    expect(html).toContain('Example</A>');
    expect(html).toContain('<DD>Desc');
  });

  it('should export bookmarks with folder hierarchy and tags in Netscape HTML', async () => {
    const customList = [
      {
        url: 'https://svelte.dev',
        title: 'Svelte <Framework>',
        folderPath: 'Bookmarks bar/Frontend',
        tags: ['web', 'ui'],
        description: 'Cybernetically enhanced web apps & more',
        createdAt: 1600000000000,
        modifiedAt: 1600000000000
      },
      {
        url: 'https://rust-lang.org',
        title: 'Rust',
        folderPath: 'Bookmarks bar/Backend',
        createdAt: 1600000000000,
        modifiedAt: 1600000000000
      }
    ] as any;

    const html = await exportAsHtml(customList);
    expect(html).toContain('<DT><H3>Bookmarks bar</H3>');
    expect(html).toContain('<DT><H3>Frontend</H3>');
    expect(html).toContain('<DT><H3>Backend</H3>');
    expect(html).toContain('TAGS="web,ui"');
    expect(html).toContain('Svelte &lt;Framework&gt;</A>');
    expect(html).toContain('<DD>Cybernetically enhanced web apps &amp; more');
  });

  it('should export bookmarks in JSON format with custom list', async () => {
    const mockData = [
      {
        url: 'https://example.com',
        title: 'Example',
        folderPath: 'Tech',
        tags: ['test'],
        createdAt: 1600000000000,
        modifiedAt: 1600000000000,
        description: 'Desc'
      }
    ];

    const jsonStr = await exportAsJson(mockData as any);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe('1.0');
    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.bookmarks[0].url).toBe('https://example.com');
    expect(parsed.bookmarks[0].tags).toEqual(['test']);
  });

  it('should export bookmarks in CSV format with Tags column', async () => {
    vi.mocked(db.bookmarks.toArray).mockResolvedValueOnce([
      {
        id: 1,
        url: 'https://example.com',
        title: 'Example "Title"',
        description: 'Desc with, comma',
        folderPath: 'Dev',
        tags: ['tag1', 'tag2'],
        visitCount: 5,
        createdAt: 1600000000000,
        modifiedAt: 1600000000000
      }
    ] as any);

    const csv = await exportAsCsv();
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2); // Header + 1 Data row
    expect(lines[0]).toBe('ID,Title,URL,Description,Folder,Tags,Visit Count,Created At,Modified At');
    expect(lines[1]).toContain('"1","Example ""Title""","https://example.com","Desc with, comma","Dev","tag1;tag2","5"');
  });
});


describe('toSafeAsciiFilename', () => {
  it('한글 포함 파일명은 ASCII 안전 이름으로 정제된다 (확장자 보존)', () => {
    const r = toSafeAsciiFilename('_증조부 친일 논란_ 하영.html');
    expect(r.endsWith('.html')).toBe(true);
    expect(r).toMatch(/^[\x20-\x7E]+\.html$/); // ASCII characters only
  });

  it('전부 비ASCII면 archive_<timestamp>로 폴백한다', () => {
    const r = toSafeAsciiFilename('한글제목.html');
    expect(r).toMatch(/^archive_\d+\.html$/);
  });

  it('OS 금지 문자는 _로 치환한다', () => {
    expect(toSafeAsciiFilename('a/b:c*.html')).toBe('a_b_c.html');
  });

  it('ASCII 파일명은 그대로 유지한다', () => {
    expect(toSafeAsciiFilename('powerbookmark_export_123.html')).toBe('powerbookmark_export_123.html');
  });
});

describe('downloadFile', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock') });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('한글 파일명이 API에서 거부되면 ASCII 안전 이름으로 재시도한다', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('Invalid filename'))
      .mockResolvedValueOnce(7);
    vi.stubGlobal('browser', { downloads: { download } });

    await downloadFile('<html>x</html>', '한글제목.html', 'text/html');

    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[0][0].filename).toBe('한글제목.html');
    expect(download.mock.calls[1][0].filename).toMatch(/^archive_\d+\.html$/);
    expect(download.mock.calls[1][0].saveAs).toBe(false);
  });

  it('ASCII 파일명은 downloads API 1회 호출로 저장한다', async () => {
    const download = vi.fn().mockResolvedValue(1);
    vi.stubGlobal('browser', { downloads: { download } });

    await downloadFile('<html>x</html>', 'file.html', 'text/html');

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0].filename).toBe('file.html');
    expect(download.mock.calls[0][0].saveAs).toBe(false);
  });
});
