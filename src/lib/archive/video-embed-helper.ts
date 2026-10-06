/**
 * Video Embed Helper for Archiving
 * Preserves live playback capabilities for YouTube, TikTok, and other video embeds in archived pages.
 */

function isSubdomainOf(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Parses timestamp string (e.g. "120", "120s", "1m30s", "1h2m3s") into total seconds.
 */
export function parseYouTubeTimestamp(timeStr: string | null | undefined): number | undefined {
  if (!timeStr) return undefined;
  const raw = timeStr.trim().toLowerCase();
  if (/^\d+s?$/.test(raw)) {
    const s = parseInt(raw, 10);
    return isNaN(s) || s <= 0 ? undefined : s;
  }
  let total = 0;
  const hours = raw.match(/(\d+)h/);
  const mins = raw.match(/(\d+)m/);
  const secs = raw.match(/(\d+)s/);
  if (hours) total += parseInt(hours[1], 10) * 3600;
  if (mins) total += parseInt(mins[1], 10) * 60;
  if (secs) total += parseInt(secs[1], 10);
  return total > 0 ? total : undefined;
}

export interface YouTubeInfo {
  videoId: string;
  startSeconds?: number;
}

/**
 * Extracts YouTube Video ID and optional start timestamp from various YouTube URL formats.
 */
export function getYouTubeVideoId(url: string): string | null {
  const info = getYouTubeVideoInfo(url);
  return info?.videoId ?? null;
}

/**
 * Extracts complete YouTube video information including video ID and start timestamp.
 */
export function getYouTubeVideoInfo(url: string): YouTubeInfo | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    const startSeconds =
      parseYouTubeTimestamp(parsed.searchParams.get('t')) ||
      parseYouTubeTimestamp(parsed.searchParams.get('start'));

    // Short domain: youtu.be/<id>
    if (isSubdomainOf(hostname, 'youtu.be')) {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? { videoId: id, startSeconds } : null;
    }

    // Standard domains: youtube.com, m.youtube.com, www.youtube-nocookie.com
    if (isSubdomainOf(hostname, 'youtube.com') || isSubdomainOf(hostname, 'youtube-nocookie.com')) {
      if (parsed.searchParams.has('v')) {
        const id = parsed.searchParams.get('v');
        return id && /^[\w-]{11}$/.test(id) ? { videoId: id, startSeconds } : null;
      }
      const paths = parsed.pathname.split('/').filter(Boolean);
      if (
        paths[0] === 'shorts' ||
        paths[0] === 'embed' ||
        paths[0] === 'v' ||
        paths[0] === 'live'
      ) {
        const id = paths[1];
        return id && /^[\w-]{11}$/.test(id) ? { videoId: id, startSeconds } : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts TikTok Video ID from TikTok URL formats (including /video/ and /photo/).
 */
export function getTikTokVideoId(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!isSubdomainOf(hostname, 'tiktok.com')) return null;

    // Standard video or photo carousel URL: /@user/video/(\d+) or /@user/photo/(\d+)
    const match = parsed.pathname.match(/\/(?:video|photo)\/(\d+)/i);
    if (match) return match[1];

    // Mobile / short redirect: /v/(\d+)
    const vMatch = parsed.pathname.match(/\/v\/(\d+)/i);
    if (vMatch) return vMatch[1];

    // Embed URL: /embed/v2/(\d+) or /embed/(\d+)
    const embedMatch = parsed.pathname.match(/\/embed(?:\/v\d+)?\/(\d+)/i);
    if (embedMatch) return embedMatch[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Checks whether an iframe URL is a video embed provider that must remain a live cross-origin iframe.
 */
export function isVideoEmbedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const fullUrl = url.startsWith('//') ? `https:${url}` : url;
    const parsed = new URL(fullUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      isSubdomainOf(hostname, 'youtube.com') ||
      isSubdomainOf(hostname, 'youtube-nocookie.com') ||
      isSubdomainOf(hostname, 'youtu.be')
    ) {
      return (
        parsed.pathname.includes('/embed/') ||
        parsed.pathname.includes('/v/') ||
        parsed.pathname.includes('/shorts/')
      );
    }
    if (isSubdomainOf(hostname, 'tiktok.com')) {
      return parsed.pathname.includes('/embed');
    }
    if (isSubdomainOf(hostname, 'player.vimeo.com') || isSubdomainOf(hostname, 'vimeo.com')) {
      return parsed.pathname.includes('/video/');
    }
    if (isSubdomainOf(hostname, 'dailymotion.com')) {
      return parsed.pathname.includes('/embed/');
    }
    // Korean video platforms (KakaoTV / Daum / Naver TV)
    if (isSubdomainOf(hostname, 'kakao.com')) {
      return parsed.pathname.includes('/embed/') || parsed.pathname.includes('/cliplink/');
    }
    if (isSubdomainOf(hostname, 'daum.net')) {
      return parsed.pathname.includes('/video/') || parsed.pathname.includes('/controller/');
    }
    if (isSubdomainOf(hostname, 'naver.com')) {
      return (
        parsed.pathname.includes('/embed/') ||
        parsed.pathname.includes('/outKeyPlayer') ||
        parsed.pathname.includes('/v/')
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Creates a responsive YouTube embed container.
 */
export function createYouTubeEmbedElement(
  doc: Document,
  videoId: string,
  title?: string,
  startSeconds?: number
): HTMLElement | null {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;

  const container = doc.createElement('div');
  container.className = 'power-bookmark-video-embed power-bookmark-youtube-embed';
  container.setAttribute(
    'style',
    'position:relative;z-index:1000;width:100%;max-width:1080px;margin:16px auto;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;background:#000000;box-shadow:0 4px 20px rgba(0,0,0,0.3);'
  );

  let embedSrc = `https://www.youtube.com/embed/${videoId}?autoplay=0&rel=0`;
  if (startSeconds && startSeconds > 0) {
    embedSrc += `&start=${startSeconds}`;
  }

  const iframe = doc.createElement('iframe');
  iframe.src = embedSrc;
  iframe.title = title || 'YouTube Video Player';
  iframe.setAttribute(
    'style',
    'position:absolute;top:0;left:0;width:100%;height:100%;border:none;margin:0;padding:0;'
  );
  iframe.setAttribute(
    'allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
  );
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

  container.appendChild(iframe);
  return container;
}

/**
 * Creates a responsive TikTok embed container.
 */
export function createTikTokEmbedElement(doc: Document, videoId: string, title?: string): HTMLElement | null {
  if (!videoId || !/^\d+$/.test(videoId)) return null;

  const container = doc.createElement('div');
  container.className = 'power-bookmark-video-embed power-bookmark-tiktok-embed';
  container.setAttribute(
    'style',
    'position:relative;z-index:1000;display:flex;justify-content:center;align-items:center;width:100%;margin:16px auto;'
  );

  const iframe = doc.createElement('iframe');
  iframe.src = `https://www.tiktok.com/embed/v2/${videoId}`;
  iframe.title = title || 'TikTok Video Player';
  iframe.setAttribute(
    'style',
    'width:100%;max-width:605px;height:750px;border:none;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.15);'
  );
  iframe.setAttribute(
    'allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
  );
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

  container.appendChild(iframe);
  return container;
}

/**
 * Injects or preserves video embeds in the archived DOM:
 * 1. For YouTube pages: replaces dead player with responsive live embed (idempotent).
 * 2. For TikTok pages: replaces dead video container with responsive live embed (idempotent).
 * 3. For pages with TikTok blockquotes: converts them to live embed iframes.
 * 4. For existing video embed iframes: preserves allow & allowfullscreen and sets referrerpolicy.
 */
export function preserveOrInjectVideoEmbeds(doc: Document, pageUrl: string, pageTitle?: string): void {
  // 1. YouTube page detection (Idempotent)
  if (!doc.querySelector('.power-bookmark-youtube-embed')) {
    const ytInfo = getYouTubeVideoInfo(pageUrl);
    if (ytInfo) {
      const embedEl = createYouTubeEmbedElement(doc, ytInfo.videoId, pageTitle, ytInfo.startSeconds);
      if (embedEl) {
        const existingPlayer = doc.querySelector(
          '#player, #player-container, #movie_player, ytd-player, #ytd-player, .html5-video-player'
        );
        if (existingPlayer) {
          existingPlayer.textContent = '';
          existingPlayer.appendChild(embedEl);
        } else {
          const insertionTarget =
            doc.querySelector('#primary, #content, [role="main"], main, body') || doc.body;
          if (insertionTarget) {
            insertionTarget.insertBefore(embedEl, insertionTarget.firstChild);
          }
        }
        // Remove or hide YouTube skeleton/custom-element overlays that cover the viewport
        doc.querySelectorAll('#watch-page-skeleton, ytd-app').forEach((el) => {
          if (!el.contains(embedEl)) {
            el.remove();
          }
        });
      }
    }
  }

  // 2. TikTok page detection (Idempotent + canonical link resolution for short links)
  if (!doc.querySelector('.power-bookmark-tiktok-embed')) {
    let ttVideoId = getTikTokVideoId(pageUrl);
    if (!ttVideoId && (pageUrl.includes('tiktok.com') || pageUrl.includes('vt.tiktok.com'))) {
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
      if (canonical) {
        ttVideoId = getTikTokVideoId(canonical);
      }
    }

    if (ttVideoId) {
      const embedEl = createTikTokEmbedElement(doc, ttVideoId, pageTitle);
      if (embedEl) {
        const existingContainer = doc.querySelector(
          '[data-e2e="browse-video"], .video-card-browse, [class*="DivVideoContainer"], [class*="VideoContainer"]'
        );
        if (existingContainer) {
          existingContainer.textContent = '';
          existingContainer.appendChild(embedEl);
        } else {
          const insertionTarget =
            doc.querySelector('[role="main"], main, body') || doc.body;
          if (insertionTarget) {
            insertionTarget.insertBefore(embedEl, insertionTarget.firstChild);
          }
        }
      }
    }
  }

  // 3. TikTok blockquote embeds on external pages
  const tiktokBlockquotes = Array.from(doc.querySelectorAll('blockquote.tiktok-embed'));
  for (const bq of tiktokBlockquotes) {
    const rawVid = bq.getAttribute('data-video-id');
    const vid = (rawVid && /^\d+$/.test(rawVid)) ? rawVid : getTikTokVideoId(bq.getAttribute('cite') || '');
    if (vid) {
      const embedEl = createTikTokEmbedElement(doc, vid, pageTitle);
      if (embedEl) {
        bq.parentNode?.replaceChild(embedEl, bq);
      }
    }
  }

  // 4. Ensure existing video iframes maintain permissions and have strict-origin-when-cross-origin
  const iframes = Array.from(doc.querySelectorAll('iframe'));
  for (const iframe of iframes) {
    const src = iframe.getAttribute('src');
    if (src && isVideoEmbedUrl(src)) {
      iframe.setAttribute(
        'allow',
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
      );
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.removeAttribute('srcdoc');
      if (!iframe.getAttribute('loading')) {
        iframe.setAttribute('loading', 'lazy');
      }
    }
  }
}
