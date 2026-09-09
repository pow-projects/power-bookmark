/**
 * Normalizes URL to improve duplicate detection accuracy.
 * - Ignores protocol (http/https) differences (optional)
 * - Lowercases hostname
 * - Removes port number (when default ports 80, 443)
 * - Removes trailing slash (/)
 * - Sorts query parameters
 * - Removes general anchor hash (#) (hash is controllable via option for hash routing cases)
 */
export function normalizeUrl(urlString: string, options: { ignoreProtocol?: boolean; keepHash?: boolean } = {}): string {
  try {
    let cleanUrl = urlString.trim();
    if (!cleanUrl) return '';

    // Parse URL
    const url = new URL(cleanUrl);

    // Lowercase hostname
    let host = url.hostname.toLowerCase();
    
    // Remove default port
    let port = url.port;
    if ((url.protocol === 'http:' && port === '80') || (url.protocol === 'https:' && port === '443')) {
      port = '';
    }

    // Normalize pathname (remove trailing /, except root path)
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    // Sort query parameters
    const searchParams = new URLSearchParams(url.search);
    const keys = Array.from(new Set(searchParams.keys())).sort();
    const sortedParams = new URLSearchParams();
    for (const key of keys) {
      const values = searchParams.getAll(key).sort();
      for (const val of values) {
        sortedParams.append(key, val);
      }
    }
    const search = sortedParams.toString() ? `?${sortedParams.toString()}` : '';

    // Determine protocol
    const protocol = options.ignoreProtocol ? 'http:' : url.protocol;

    // Handle hash
    let hash = '';
    if (options.keepHash && url.hash) {
      hash = url.hash;
    }

    const portSuffix = port ? `:${port}` : '';
    return `${protocol}//${host}${portSuffix}${pathname}${search}${hash}`;
  } catch (e) {
    // Fallback on URL parse failure: return lowercased and trimmed original string
    return urlString.trim().toLowerCase();
  }
}

/**
 * Checks whether two URLs point to substantially the same page.
 */
export function isDuplicateUrl(url1: string, url2: string): boolean {
  const norm1 = normalizeUrl(url1, { ignoreProtocol: true, keepHash: false });
  const norm2 = normalizeUrl(url2, { ignoreProtocol: true, keepHash: false });
  return norm1 === norm2;
}

/**
 * URL-based deterministic UUID generator (UUID v5).
 * Ensures permanently immutable syncId for the same URL in bookmark creation, cloud synchronization, and multi-device environments.
 */
export function generateDeterministicSyncId(rawUrl: string): string {
  const norm = normalizeUrl(rawUrl || '');
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5, h3 = 0x811c9dc5, h4 = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c * 31), 0x01000193);
    h3 = Math.imul(h3 ^ (c * 127), 0x01000193);
    h4 = Math.imul(h4 ^ (c * 8191), 0x01000193);
  }
  const b = new Uint8Array(16);
  const view = new DataView(b.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint32(4, h2 >>> 0);
  view.setUint32(8, h3 >>> 0);
  view.setUint32(12, h4 >>> 0);

  // Set UUID version 5 (name-based) and variant RFC 4122:
  b[6] = (b[6] & 0x0f) | 0x50; // Version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(b, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

