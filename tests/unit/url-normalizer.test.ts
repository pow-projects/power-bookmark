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

describe('isLoopbackHost', () => {
  it('identifies localhost and subdomains of localhost', async () => {
    const { isLoopbackHost } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('my.localhost')).toBe(true);
    expect(isLoopbackHost('api.my.localhost')).toBe(true);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });

  it('identifies 127.0.0.0/8 IPv4 loopback addresses', async () => {
    const { isLoopbackHost } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });

  it('identifies IPv6 loopback and zero addresses', async () => {
    const { isLoopbackHost } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
    expect(isLoopbackHost('::')).toBe(true);
  });

  it('returns false for remote or private network hosts', async () => {
    const { isLoopbackHost } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(isLoopbackHost('api.openai.com')).toBe(false);
    expect(isLoopbackHost('dav.box.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('ensureUrlProtocol', () => {
  it('automatically prepends http:// when protocol is omitted for loopback hosts', async () => {
    const { ensureUrlProtocol } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(ensureUrlProtocol('localhost:8085')).toBe('http://localhost:8085');
    expect(ensureUrlProtocol('localhost:8085/')).toBe('http://localhost:8085/');
    expect(ensureUrlProtocol('127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(ensureUrlProtocol('[::1]:8080')).toBe('http://[::1]:8080');
    expect(ensureUrlProtocol('::1')).toBe('http://[::1]');
    expect(ensureUrlProtocol('::1/v1')).toBe('http://[::1]/v1');
    expect(ensureUrlProtocol('0.0.0.0:8000/v1')).toBe('http://0.0.0.0:8000/v1');
    expect(ensureUrlProtocol('admin:pass@localhost:8085')).toBe('http://admin:pass@localhost:8085');
  });

  it('automatically prepends https:// when protocol is omitted for non-loopback hosts', async () => {
    const { ensureUrlProtocol } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(ensureUrlProtocol('api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(ensureUrlProtocol('dav.box.com/remote.php/webdav')).toBe('https://dav.box.com/remote.php/webdav');
    expect(ensureUrlProtocol('my-nas.synology.me:5001/webdav')).toBe('https://my-nas.synology.me:5001/webdav');
    expect(ensureUrlProtocol('admin:secret@dav.box.com/dav')).toBe('https://admin:secret@dav.box.com/dav');
    expect(ensureUrlProtocol('192.168.1.10:8080')).toBe('https://192.168.1.10:8080');
  });

  it('prevents loopback spoofing via query, fragment, or backslash @ tricks', async () => {
    const { ensureUrlProtocol } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(ensureUrlProtocol('attacker.com?redirect=@localhost')).toBe('https://attacker.com?redirect=@localhost');
    expect(ensureUrlProtocol('attacker.com#tab=@localhost')).toBe('https://attacker.com#tab=@localhost');
    expect(ensureUrlProtocol('attacker.com\\@localhost')).toBe('https://attacker.com\\@localhost');
  });

  it('preserves existing protocol (http/https)', async () => {
    const { ensureUrlProtocol } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(ensureUrlProtocol('http://api.openai.com/v1')).toBe('http://api.openai.com/v1');
    expect(ensureUrlProtocol('https://localhost:8443')).toBe('https://localhost:8443');
    expect(ensureUrlProtocol('http://localhost:8085/')).toBe('http://localhost:8085/');
  });

  it('handles empty or whitespace strings', async () => {
    const { ensureUrlProtocol } = await import('../../src/lib/bookmarks/url-normalizer');
    expect(ensureUrlProtocol('')).toBe('');
    expect(ensureUrlProtocol('   ')).toBe('');
  });
});
