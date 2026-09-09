/**
 * Detects charset from Content-Type header string and HTML bytes (ArrayBuffer).
 * Exported for testability.
 */
export function detectCharset(contentType: string | null, htmlBytes: ArrayBuffer): string {
  // 1. Check Content-Type header
  if (contentType) {
    const match = contentType.match(/charset=([\w-]+)/i);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  }

  // 2. Check HTML meta tags (at most first 4096 bytes)
  const chunk = new Uint8Array(htmlBytes, 0, Math.min(htmlBytes.byteLength, 4096));
  const chunkStr = new TextDecoder('ascii').decode(chunk);
  
  // <meta charset="XXX"> or <meta http-equiv="Content-Type" content="text/html; charset=XXX">
  const metaCharsetMatch = chunkStr.match(/<meta\s+[^>]*charset\s*=\s*["']?([\w-]+)["']?/i);
  if (metaCharsetMatch && metaCharsetMatch[1]) {
    return metaCharsetMatch[1].toLowerCase();
  }

  // 3. Default value
  return 'utf-8';
}

/**
 * Detects charset from Response object and returns properly decoded HTML text.
 * 1) charset parameter in Content-Type header
 * 2) charset declaration in HTML <meta> tags
 * 3) If neither is present, defaults to UTF-8
 */
export async function decodeResponseHtml(response: Response): Promise<string> {
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type');
  const charset = detectCharset(contentType, arrayBuffer);

  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    return decoder.decode(arrayBuffer);
  } catch (e) {
    // If the charset is not supported by TextDecoder, fall back to utf-8
    const fallbackDecoder = new TextDecoder('utf-8', { fatal: false });
    return fallbackDecoder.decode(arrayBuffer);
  }
}

/**
 * Fetches a URL and returns properly decoded HTML string by detecting its charset.
 * Similar to fetchWithTimeout, but includes charset detection.
 */
export async function fetchHtmlWithCharset(url: string, options?: RequestInit, timeout: number = 10000): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options?.signal || controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with status: ${response.status}`);
    }

    return await decodeResponseHtml(response);
  } finally {
    clearTimeout(id);
  }
}
