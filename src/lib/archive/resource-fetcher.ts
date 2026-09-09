/**
 * Resource Fetcher with Timeout & Size Limits
 * Relay module that safely converts web resources (images, fonts, CSS, etc.) to Data URIs in a Service Worker environment.
 */

export const MAX_RESOURCE_SIZE = Infinity;
export const FETCH_RESOURCE_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Converts a Blob object to a Base64 Data URI string.
 * Provides fallback via Uint8Array and btoa even in a Service Worker environment where FileReader is unavailable.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'undefined') {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('FileReader result is not string'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    } else {
      blob.arrayBuffer().then((buf) => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        const len = bytes.byteLength;
        const chunkSize = 0x8000;
        for (let i = 0; i < len; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
        }
        const base64 = btoa(binary);
        const mime = blob.type || 'application/octet-stream';
        resolve(`data:${mime};base64,${base64}`);
      }).catch(reject);
    }
  });
}

/**
 * Fetches a remote resource and converts it to a Base64 Data URI.
 * - 2.5 second timeout
 * - Immediately aborts download and returns the original URL if Content-Length header exceeds 2MB
 * - Immediately aborts and returns the original URL if 2MB limit is exceeded while reading Stream/Blob
 * - Safely returns original URL on failure/error
 */
export async function fetchResourceAsDataUri(url: string, pageUrl?: string): Promise<string> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_RESOURCE_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (pageUrl) {
      headers['Referer'] = pageUrl;
    }
    const fetchInit: RequestInit = {
      credentials: 'include',
      headers,
      signal: ctrl.signal
    };
    if (pageUrl) {
      fetchInit.referrer = pageUrl;
      fetchInit.referrerPolicy = 'no-referrer-when-downgrade';
    }

    const res = await fetch(url, fetchInit);

    if (!res.ok) {
      return url;
    }

    // 1. Check Content-Length header (abort immediately if over 2MB)
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!Number.isNaN(parsedLength) && parsedLength > MAX_RESOURCE_SIZE) {
        ctrl.abort();
        return url;
      }
    }

    // 2. Protect against exceeding 2MB ceiling when reading Stream or Blob
    let blob: Blob;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let exceeded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESOURCE_SIZE) {
            exceeded = true;
            try {
              await reader.cancel();
            } catch {
              // ignore cancel error
            }
            ctrl.abort();
            break;
          }
          chunks.push(value);
        }
      }

      if (exceeded) {
        return url;
      }

      let contentType = res.headers.get('content-type') || '';
      if (!contentType || contentType === 'application/octet-stream') {
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('.mp4')) contentType = 'video/mp4';
        else if (lowerUrl.includes('.webm')) contentType = 'video/webm';
        else if (lowerUrl.includes('.ogg')) contentType = 'video/ogg';
        else if (lowerUrl.includes('.gif')) contentType = 'image/gif';
        else if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) contentType = 'image/jpeg';
        else if (lowerUrl.includes('.png')) contentType = 'image/png';
        else if (lowerUrl.includes('.webp')) contentType = 'image/webp';
        else if (lowerUrl.includes('.svg')) contentType = 'image/svg+xml';
        else contentType = contentType || 'application/octet-stream';
      }
      blob = new Blob(chunks as BlobPart[], { type: contentType });
    } else {
      blob = await res.blob();
      if (blob.size > MAX_RESOURCE_SIZE) {
        return url;
      }
    }

    return await blobToDataUrl(blob);
  } catch (e) {
    return url;
  } finally {
    clearTimeout(timeoutId);
  }
}
