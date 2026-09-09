import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseNetscapeHtml,
  parseJsonBookmarks,
  importFromHtml,
  importFromJson,
  unescapeHtml,
  parseCsv,
  parseCsvBookmarks,
  importFromCsv
} from '../../src/lib/bookmarks/import-manager';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import { exportAsCsv } from '../../src/lib/bookmarks/export-manager';

describe('ImportManager - Netscape HTML Import', () => {
  it('should correctly parse sample dead bookmarks HTML content', () => {
    const htmlContent = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://httpbin.org/status/404" ADD_DATE="1600000000">[404 Dead] HTTPBin 404 Not Found</A>
    <DD>HTTP 404 응답을 반환하는 테스트용 주소
    <DT><A HREF="https://httpbin.org/status/500" ADD_DATE="1600000001">HTTPBin 500</A>
    <DD>500 Internal Server Error
    <DT><A HREF="https://httpbin.org/status/200" ADD_DATE="1600000002">HTTPBin 200</A>
    <DD>200 OK
    <DT><A HREF="https://httpbin.org/delay/10" ADD_DATE="1600000003">HTTPBin Timeout</A>
    <DD>Timeout test
    <DT><A HREF="https://this-domain-does-not-exist-123456789.invalid/" ADD_DATE="1600000004">Invalid Domain</A>
    <DD>NXDOMAIN
    <DT><A HREF="https://10.255.255.1/" ADD_DATE="1600000005">Unreachable IP</A>
    <DD>Connection refused
</DL><p>
    `;
    const bookmarks = parseNetscapeHtml(htmlContent);

    expect(bookmarks.length).toBe(6);
    expect(bookmarks[0].url).toBe('https://httpbin.org/status/404');
    expect(bookmarks[0].title).toBe('[404 Dead] HTTPBin 404 Not Found');
    expect(bookmarks[0].description).toBe('HTTP 404 응답을 반환하는 테스트용 주소');

    expect(bookmarks[4].url).toBe('https://this-domain-does-not-exist-123456789.invalid/');
    expect(bookmarks[5].url).toBe('https://10.255.255.1/');
    expect(bookmarks[0].createdAt).toBe(1600000000000);
    expect(bookmarks[0].modifiedAt).toBe(1600000000000);
  });

  it('should parse both ADD_DATE and LAST_MODIFIED when present', () => {
    const html = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://example.com" ADD_DATE="1600000000" LAST_MODIFIED="1650000000">Example</A>
    <DD>Example description
</DL><p>
    `;
    const [bm] = parseNetscapeHtml(html);
    expect(bm.url).toBe('https://example.com');
    expect(bm.createdAt).toBe(1600000000000);
    expect(bm.modifiedAt).toBe(1650000000000);
  });

  it('should correctly parse folder hierarchy and tags in Netscape HTML', () => {
    const html = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000">Bookmarks bar</H3>
    <DL><p>
        <DT><H3>Dev</H3>
        <DL><p>
            <DT><A HREF="https://svelte.dev?query=1&amp;tab=2" TAGS="frontend,ui" ADD_DATE="1600000010">Svelte &amp; Kit</A>
            <DD>Web &lt;framework&gt;
        </DL><p>
        <DT><A HREF="https://vitest.dev" TAGS="testing">Vitest</A>
    </DL><p>
    <DT><A HREF="https://root.com">Root Bookmark</A>
</DL><p>
    `;
    const bookmarks = parseNetscapeHtml(html);
    expect(bookmarks).toHaveLength(3);

    expect(bookmarks[0].url).toBe('https://svelte.dev?query=1&tab=2');
    expect(bookmarks[0].title).toBe('Svelte & Kit');
    expect(bookmarks[0].description).toBe('Web <framework>');
    expect(bookmarks[0].folderPath).toBe('Bookmarks bar/Dev');
    expect(bookmarks[0].tags).toEqual(['frontend', 'ui']);

    expect(bookmarks[1].url).toBe('https://vitest.dev');
    expect(bookmarks[1].folderPath).toBe('Bookmarks bar');
    expect(bookmarks[1].tags).toEqual(['testing']);

    expect(bookmarks[2].url).toBe('https://root.com');
    expect(bookmarks[2].folderPath).toBeUndefined();
  });
});

describe('ImportManager - HTML Entity Unescaping', () => {
  it('should correctly unescape HTML entities and numeric codes', () => {
    expect(unescapeHtml('Tom &amp; Jerry &#039;Cat&#039; &quot;Dog&quot;')).toBe("Tom & Jerry 'Cat' \"Dog\"");
    expect(unescapeHtml('&lt;tag&gt; &#65;&#66; &#x43;')).toBe('<tag> AB C');
  });
});

describe('ImportManager - JSON Parsing', () => {
  it('should parse PowerBookmark JSON backup format', () => {
    const jsonStr = JSON.stringify({
      version: '1.0',
      exportedAt: 1600000000000,
      bookmarks: [
        {
          url: 'https://example.com',
          title: 'Example',
          description: 'Desc',
          folderPath: 'Dev/Web',
          tags: ['tech'],
          createdAt: 1600000000000,
          modifiedAt: 1600000000000
        }
      ]
    });

    const parsed = parseJsonBookmarks(jsonStr);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('https://example.com');
    expect(parsed[0].folderPath).toBe('Dev/Web');
    expect(parsed[0].tags).toEqual(['tech']);
  });
});

describe('ImportManager - importFromHtml & importFromJson execution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip duplicates and create new bookmarks', async () => {
    vi.spyOn(BookmarkManager, 'setSyncMuted').mockImplementation(() => {});
    vi.spyOn(BookmarkManager, 'findDuplicate')
      .mockResolvedValueOnce(undefined) // 1st item: new
      .mockResolvedValueOnce({ id: 10 } as any); // 2nd item: duplicate

    vi.spyOn(BookmarkManager, 'ensureFolderPath').mockResolvedValue({ id: 'folder-1', path: 'Dev' });
    const createSpy = vi.spyOn(BookmarkManager, 'createBookmark').mockResolvedValue({} as any);

    const html = `
<DL><p>
    <DT><H3>Dev</H3>
    <DL><p>
        <DT><A HREF="https://new-item.com" TAGS="new">New Item</A>
        <DT><A HREF="https://dup-item.com">Dup Item</A>
    </DL><p>
</DL><p>
    `;

    const result = await importFromHtml(html);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      'https://new-item.com',
      'New Item',
      'folder-1',
      '',
      expect.objectContaining({ createdAt: expect.any(Number) }),
      ['new']
    );
  });

  it('should import from JSON correctly', async () => {
    vi.spyOn(BookmarkManager, 'setSyncMuted').mockImplementation(() => {});
    vi.spyOn(BookmarkManager, 'findDuplicate').mockResolvedValue(undefined);
    const createSpy = vi.spyOn(BookmarkManager, 'createBookmark').mockResolvedValue({} as any);

    const json = JSON.stringify({
      bookmarks: [
        { url: 'https://json-test.com', title: 'JSON Test', description: 'Test description' }
      ]
    });

    const result = await importFromJson(json);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('should import from CSV correctly and skip duplicates', async () => {
    vi.spyOn(BookmarkManager, 'setSyncMuted').mockImplementation(() => {});
    vi.spyOn(BookmarkManager, 'findDuplicate')
      .mockResolvedValueOnce(undefined) // 1st item: new
      .mockResolvedValueOnce({ id: 20 } as any); // 2nd item: duplicate

    vi.spyOn(BookmarkManager, 'ensureFolderPath').mockResolvedValue({ id: 'f-1', path: 'Dev' });
    const createSpy = vi.spyOn(BookmarkManager, 'createBookmark').mockResolvedValue({} as any);

    const csv = `URL,Title,Folder,Tags
https://new-csv.com,New CSV,Dev,"tag1;tag2"
https://dup-csv.com,Dup CSV,,`;

    const result = await importFromCsv(csv);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      'https://new-csv.com',
      'New CSV',
      'f-1',
      '',
      expect.objectContaining({ createdAt: expect.any(Number) }),
      ['tag1', 'tag2']
    );
  });
});

describe('ImportManager - parseCsv RFC 4180 Parser', () => {
  it('should parse standard RFC 4180 CSV with quotes, commas, and escaped quotes', () => {
    const csv = 'col1,col2,col3\n"val, 1","val ""2""","val 3"';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['col1', 'col2', 'col3'],
      ['val, 1', 'val "2"', 'val 3']
    ]);
  });

  it('should parse multiline cells with CRLF and LF', () => {
    const csv = 'col1,col2\n"line 1\nline 2","crlf 1\r\ncrlf 2"';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['col1', 'col2'],
      ['line 1\nline 2', 'crlf 1\r\ncrlf 2']
    ]);
  });

  it('should strip UTF-8 BOM when present', () => {
    const csv = '\uFEFFurl,title\nhttps://example.com,Example';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['url', 'title'],
      ['https://example.com', 'Example']
    ]);
  });

  it('should tolerate unquoted quotes appearing mid-field', () => {
    const csv = 'title,price\nMonitor 27" 4K,299';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['title', 'price'],
      ['Monitor 27" 4K', '299']
    ]);
  });

  it('should skip empty and whitespace-only rows and handle trailing newlines', () => {
    const csv = '\nheader1,header2\n\nval1,val2\n   \n\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['header1', 'header2'],
      ['val1', 'val2']
    ]);
  });

  it('should gracefully flush unclosed quote at EOF', () => {
    const csv = 'url,title\nhttps://example.com,"Unclosed Title';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['url', 'title'],
      ['https://example.com', 'Unclosed Title']
    ]);
  });
});

describe('ImportManager - parseCsvBookmarks', () => {
  it('should roundtrip parse exportAsCsv output accurately', async () => {
    const mockBookmarks: any[] = [
      {
        id: 'bm-1',
        title: 'Vitest Guide',
        url: 'https://vitest.dev',
        description: 'Blazing fast test runner',
        folderPath: 'Dev/Testing',
        tags: ['test', 'vite'],
        visitCount: 12,
        createdAt: 1600000000000,
        modifiedAt: 1600005000000
      }
    ];

    const csv = await exportAsCsv(mockBookmarks);
    const parsed = parseCsvBookmarks(csv);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('https://vitest.dev');
    expect(parsed[0].title).toBe('Vitest Guide');
    expect(parsed[0].description).toBe('Blazing fast test runner');
    expect(parsed[0].folderPath).toBe('Dev/Testing');
    expect(parsed[0].tags).toEqual(['test', 'vite']);
    expect(parsed[0].createdAt).toBe(1600000000000);
    expect(parsed[0].modifiedAt).toBe(1600005000000);
  });

  it('should map third-party header aliases correctly', () => {
    const csv = 'Link,Name,Memo,Category,Tag\nhttps://example.com,Example Name,Some note,/Web/Bookmarks/,frontend';
    const parsed = parseCsvBookmarks(csv);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('https://example.com');
    expect(parsed[0].title).toBe('Example Name');
    expect(parsed[0].description).toBe('Some note');
    expect(parsed[0].folderPath).toBe('Web/Bookmarks');
    expect(parsed[0].tags).toEqual(['frontend']);
  });

  it('should validate and sanitize URLs (prepend https://, reject javascript: and data:)', () => {
    const csv = `URL,Title
example.org,No Protocol
javascript:alert(1),XSS Attempt
data:text/html;base64,PHNjcmlwdD4=,Data URL
https://safe.org,Safe Link`;

    const parsed = parseCsvBookmarks(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].url).toBe('https://example.org');
    expect(parsed[0].title).toBe('No Protocol');
    expect(parsed[1].url).toBe('https://safe.org');
    expect(parsed[1].title).toBe('Safe Link');
  });

  it('should throw error when URL column is missing', () => {
    const csv = 'Title,Description\nTest,No URL here';
    expect(() => parseCsvBookmarks(csv)).toThrow('No URL column found in CSV');
  });

  it('should fallback title to URL if title is missing', () => {
    const csv = 'URL,Title\nhttps://notitle.com,';
    const parsed = parseCsvBookmarks(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('https://notitle.com');
    expect(parsed[0].title).toBe('https://notitle.com');
  });

  it('should parse tags with semicolon, comma, and pipe delimiters and deduplicate', () => {
    const csv = 'URL,Tags\nhttps://example.com,"tag1, tag2; tag3|tag1; ;"';
    const parsed = parseCsvBookmarks(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tags).toEqual(['tag1', 'tag2', 'tag3']);
  });

  it('should eliminate spaces from tags when parsing CSV', () => {
    const csv = 'URL,Tags\nhttps://example.com,"machine learning, 인공 지능, #웹 개발"';
    const parsed = parseCsvBookmarks(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tags).toEqual(['machinelearning', '인공지능', '웹개발']);
  });

  it('should parse various date formats (ISO string, epoch ms, epoch s, and fallback)', () => {
    const csv = `URL,Created At,Modified At
https://a.com,2024-01-01T00:00:00.000Z,2024-01-02T00:00:00.000Z
https://b.com,1600000000,1650000000
https://c.com,1600000000000,1650000000000
https://d.com,invalid,`;

    const parsed = parseCsvBookmarks(csv);
    expect(parsed).toHaveLength(4);

    expect(parsed[0].createdAt).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
    expect(parsed[0].modifiedAt).toBe(new Date('2024-01-02T00:00:00.000Z').getTime());

    expect(parsed[1].createdAt).toBe(1600000000000);
    expect(parsed[1].modifiedAt).toBe(1650000000000);

    expect(parsed[2].createdAt).toBe(1600000000000);
    expect(parsed[2].modifiedAt).toBe(1650000000000);

    expect(typeof parsed[3].createdAt).toBe('number');
    expect(parsed[3].modifiedAt).toBe(parsed[3].createdAt);
  });

  it('should parse realistic sample bookmark.csv file without errors', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const filePath = path.resolve(__dirname, '../../samples/bookmark.csv');
    if (fs.existsSync(filePath)) {
      const csv = fs.readFileSync(filePath, 'utf8');
      const bookmarks = parseCsvBookmarks(csv);
      expect(bookmarks.length).toBeGreaterThan(100);
      expect(bookmarks[0].url).toBeTruthy();
      expect(bookmarks[0].title).toBeTruthy();
      expect(bookmarks[0].createdAt).toBeGreaterThan(0);
    }
  });
});



