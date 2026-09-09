/**
 * Blocked domain list including ad networks, trackers, and error tracking
 */
export const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  // Ad networks
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'criteo.com',
  'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'openx.net',
  'pubmatic.com', 'casalemedia.com', 'serving-sys.com', 'moatads.com', 'adsafeprotected.com',
  'bidswitch.net', 'taboola.com', 'outbrain.com', 'zergnet.com', 'ligatus.com',
  'revcontent.com', 'teads.tv', 'sharethrough.com', 'media.net', '33across.com',
  'yieldmo.com', 'indexexchange.com', 'smartadserver.com', 'sovrn.com', 'triplelift.com',
  
  // Trackers
  'google-analytics.com', 'googletagmanager.com', 'facebook.net', 'connect.facebook.net',
  'bat.bing.com', 'analytics.twitter.com', 'hotjar.com', 'clarity.ms', 'newrelic.com',
  'nr-data.net', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'quantserve.com', 'scorecardresearch.com', 'chartbeat.com', 'optimizely.com',
  
  // Error tracking
  'sentry.io', 'bugsnag.com', 'rollbar.com'
] as const);

/**
 * Checks whether the given URL belongs to a blocked domain.
 * Subdomains are also checked.
 * 
 * @param url URL string to check
 * @returns true if it is a blocked domain, false if not or if the URL is invalid
 */
export function isBlockedUrl(url: string): boolean {
  if (!url) return false;
  
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    
    for (const domain of BLOCKED_DOMAINS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }
    
    return false;
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * Regular expression to determine if an iframe src attribute is a tracker
 */
const IFRAME_TRACKER_PATTERN = /criteo|doubleclick|googlesyndication|facebook\.com\/tr|amazon-adsystem|adnxs|rubiconproject|moatads|adsafeprotected|serving-sys|taboola|outbrain|zergnet|teads|sharethrough/i;

/**
 * Checks the src URL of an iframe to determine whether loading should be skipped.
 * 
 * @param src src attribute value of the iframe
 * @returns true if it is a tracker URL that should be skipped
 */
export function shouldSkipIframe(src: string | null | undefined): boolean {
  if (!src) return false;
  return IFRAME_TRACKER_PATTERN.test(src);
}

/**
 * List of CSS selectors for junk elements to remove
 */
const JUNK_SELECTORS = [
  // Ad containers
  '[id*="google_ads"]', '.adsbygoogle', 'ins.adsbygoogle', '[data-ad-slot]', '[data-ad-client]',
  '[id*="taboola"]', '[id*="outbrain"]', '.ad-wrapper', '.ad-container', '.advertisement', '[id*="ad-banner"]',
  
  // Cookie consent banners
  '[id*="cookie-consent"]', '[id*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-banner"]',
  '[id*="gdpr"]', '[class*="gdpr"]', '[id*="ccpa"]',
  
  // Social widgets
  '.fb-like', '.twitter-share-button', 'iframe[src*="platform.twitter"]', 'iframe[src*="facebook.com/plugins"]',
  
  // Unnecessary link/meta tags
  'link[rel="prefetch"]', 'link[rel="dns-prefetch"]', 'link[rel="preconnect"]',
  'meta[name="facebook-domain-verification"]', 'meta[name="google-site-verification"]'
].join(',');

/**
 * Checks whether the given element is inside the main content area and should be protected.
 * 
 * @param element DOM element to check
 * @returns true if inside the content area
 */
function isProtected(element: Element): boolean {
  return element.closest('article, main, [role="main"]') !== null;
}

/**
 * Cleans up ads, trackers, and other unnecessary elements from the parsed Document object.
 * Elements within the content area are protected.
 * 
 * @param doc Document object to sanitize
 */
export function sanitizeDOM(doc: Document): void {
  // 1. Remove junk elements matching selectors
  const junkElements = doc.querySelectorAll(JUNK_SELECTORS);
  junkElements.forEach(el => {
    if (!isProtected(el)) {
      el.remove();
    }
  });

  // 2. Filter iframes (tracker patterns or invisible iframes)
  const iframes = doc.querySelectorAll('iframe');
  iframes.forEach(iframe => {
    if (isProtected(iframe)) return;

    const src = iframe.getAttribute('src');
    const width = iframe.getAttribute('width');
    const height = iframe.getAttribute('height');
    const style = iframe.getAttribute('style') || '';

    const isTracker = src ? shouldSkipIframe(src) : false;
    const isHidden = 
      width === '0' || width === '1' || 
      height === '0' || height === '1' ||
      style.includes('display:none') || style.includes('display: none') ||
      style.includes('visibility:hidden') || style.includes('visibility: hidden');

    if (isTracker || isHidden) {
      iframe.remove();
    }
  });

  // 3. Remove tracking pixels (invisible images)
  const images = doc.querySelectorAll('img');
  images.forEach(img => {
    if (isProtected(img)) return;

    const width = img.getAttribute('width');
    const height = img.getAttribute('height');

    if (width === '0' || width === '1' || height === '0' || height === '1') {
      img.remove();
    }
  });
}
