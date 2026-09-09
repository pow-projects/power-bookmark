import { describe, it, expect } from 'vitest';
import { normalizeUrl, isDuplicateUrl } from '../../src/lib/bookmarks/url-normalizer';

describe('URL Normalizer', () => {
  it('should normalize hostname to lowercase', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Path')).toBe('https://example.com/Path');
  });

  it('should remove default port numbers', () => {
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com:443/')).toBe('https://example.com/');
    expect(normalizeUrl('http://example.com:8080/')).toBe('http://example.com:8080/');
  });

  it('should remove trailing slash', () => {
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('should sort query parameters', () => {
    expect(normalizeUrl('https://example.com/path?b=2&a=1')).toBe('https://example.com/path?a=1&b=2');
    expect(normalizeUrl('https://example.com/path?b=2&a=1&a=3')).toBe('https://example.com/path?a=1&a=3&b=2');
  });

  it('should optionally ignore protocol', () => {
    expect(normalizeUrl('https://example.com', { ignoreProtocol: true })).toBe('http://example.com/');
    expect(normalizeUrl('http://example.com', { ignoreProtocol: true })).toBe('http://example.com/');
  });

  it('should optionally keep or remove hash', () => {
    expect(normalizeUrl('https://example.com#section')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com#section', { keepHash: true })).toBe('https://example.com/#section');
  });

  it('should determine duplicate urls correctly', () => {
    expect(isDuplicateUrl('https://example.com/', 'http://example.com')).toBe(true);
    expect(isDuplicateUrl('https://example.com/path?b=2&a=1', 'http://example.com/path/?a=1&b=2')).toBe(true);
    expect(isDuplicateUrl('https://example.com/path1', 'https://example.com/path2')).toBe(false);
  });
});
