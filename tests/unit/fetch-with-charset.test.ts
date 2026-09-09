import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCharset, decodeResponseHtml, fetchHtmlWithCharset } from '../../src/lib/archive/fetch-with-charset';

describe('detectCharset', () => {
  const htmlToBuffer = (html: string) => new TextEncoder().encode(html).buffer;

  it('Content-Type 헤더에서 charset을 감지한다', () => {
    const buffer = htmlToBuffer('<html></html>');
    expect(detectCharset('text/html; charset=euc-kr', buffer)).toBe('euc-kr');
    expect(detectCharset('text/html; charset=Shift_JIS', buffer)).toBe('shift_jis');
  });

  it('헤더가 없을 때 <meta charset="...">에서 감지한다', () => {
    const buffer = htmlToBuffer('<html><head><meta charset="euc-kr"></head></html>');
    expect(detectCharset(null, buffer)).toBe('euc-kr');
  });

  it('헤더가 없을 때 <meta http-equiv="...">에서 감지한다', () => {
    const buffer = htmlToBuffer('<html><head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr"></head></html>');
    expect(detectCharset(null, buffer)).toBe('euc-kr');
  });

  it('대소문자를 구분하지 않는다', () => {
    const buffer = htmlToBuffer('<html><head><meta CHARset="EUC-KR"></head></html>');
    expect(detectCharset(null, buffer)).toBe('euc-kr');
  });

  it('헤더와 메타 태그 모두 없으면 utf-8을 반환한다', () => {
    const buffer = htmlToBuffer('<html><head></head></html>');
    expect(detectCharset(null, buffer)).toBe('utf-8');
  });
});

describe('decodeResponseHtml', () => {
  it('euc-kr로 인코딩된 Response를 올바르게 디코딩한다', async () => {
    // "test" in euc-kr
    const eucKrBytes = new Uint8Array([0xc5, 0xd7, 0xbd, 0xba, 0xc6, 0xae]);
    const mockResponse = new Response(eucKrBytes, {
      headers: { 'Content-Type': 'text/html; charset=euc-kr' }
    });
    
    const text = await decodeResponseHtml(mockResponse);
    expect(text).toBe('테스트');
  });
});

describe('fetchHtmlWithCharset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetch 후 성공적인 응답을 디코딩하여 반환한다', async () => {
    const globalFetch = global.fetch;
    const eucKrBytes = new Uint8Array([0xc5, 0xd7, 0xbd, 0xba, 0xc6, 0xae]);
    
    const mockFetch = vi.fn().mockResolvedValue(new Response(eucKrBytes, {
      headers: { 'Content-Type': 'text/html; charset=euc-kr' }
    }));
    global.fetch = mockFetch as any;

    try {
      const result = await fetchHtmlWithCharset('https://example.com');
      expect(result).toBe('테스트');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    } finally {
      global.fetch = globalFetch;
    }
  });

  it('응답이 ok가 아니면 에러를 던진다', async () => {
    const globalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue(new Response('Not Found', {
      status: 404,
      statusText: 'Not Found'
    }));
    global.fetch = mockFetch as any;

    try {
      await expect(fetchHtmlWithCharset('https://example.com')).rejects.toThrow('Fetch failed with status: 404');
    } finally {
      global.fetch = globalFetch;
    }
  });
});
