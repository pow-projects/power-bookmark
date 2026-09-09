import type { ExtractedPagePayload } from '../ai/types';

/**
 * Mapping table for standard HTML named entities
 */
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&laquo;': '«',
  '&raquo;': '»',
  '&middot;': '·',
  '&bull;': '•',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&cent;': '¢',
  '&pound;': '£',
  '&yen;': '¥',
  '&euro;': '€',
  '&sect;': '§',
  '&deg;': '°',
  '&plusmn;': '±',
  '&times;': '×',
  '&divide;': '÷'
};

/**
 * Decodes HTML entities (named entities, decimal, and hexadecimal numeric entities) in a string.
 * Operates purely via string manipulation without DOMParser or DOM APIs, making it safe for Service Workers.
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    const lower = match.toLowerCase();
    if (NAMED_ENTITIES[lower]) return NAMED_ENTITIES[lower];
    if (NAMED_ENTITIES[match]) return NAMED_ENTITIES[match];

    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      try {
        const code = parseInt(entity.slice(2), 16);
        return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }

    if (entity.startsWith('#')) {
      try {
        const code = parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }

    return match;
  });
}

/**
 * Extracts metadata (page title, meta description, og/twitter fallback values) from an HTML string.
 */
export function extractMetaFromHtml(html: string): { title: string; metaDescription: string } {
  if (!html) return { title: '', metaDescription: '' };

  let title = '';
  let metaDescription = '';

  // 1. Extract <title>...</title>
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
  }

  // 2. Extract <meta ...> tags
  const metaTagRegex = /<meta\b([^>]*)>/gi;
  let metaMatch: RegExpExecArray | null;
  let ogTitle = '';
  let twitterTitle = '';
  let standardDesc = '';
  let ogDesc = '';
  let twitterDesc = '';

  while ((metaMatch = metaTagRegex.exec(html)) !== null) {
    const attrs = metaMatch[1];

    const nameMatch = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const propMatch = attrs.match(/\bproperty\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const contentMatch = attrs.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);

    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? '').toLowerCase();
    const prop = (propMatch?.[1] ?? propMatch?.[2] ?? propMatch?.[3] ?? '').toLowerCase();
    const rawContent = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? '';
    const content = decodeHtmlEntities(rawContent).replace(/\s+/g, ' ').trim();

    if (!content) continue;

    if (name === 'description') {
      if (!standardDesc) standardDesc = content;
    } else if (prop === 'og:description') {
      if (!ogDesc) ogDesc = content;
    } else if (name === 'twitter:description') {
      if (!twitterDesc) twitterDesc = content;
    }

    if (prop === 'og:title') {
      if (!ogTitle) ogTitle = content;
    } else if (name === 'twitter:title') {
      if (!twitterTitle) twitterTitle = content;
    }
  }

  if (!title) {
    title = ogTitle || twitterTitle || '';
  }

  metaDescription = standardDesc || ogDesc || twitterDesc || '';

  return { title, metaDescription };
}

/**
 * List of tags whose contents (including child nodes) should be completely removed
 */
const STRIP_TAGS_WITH_CONTENT = [
  'head',
  'script',
  'style',
  'noscript',
  'iframe',
  'header',
  'footer',
  'nav',
  'aside',
  'form',
  'svg'
];

/**
 * Removes unnecessary elements such as scripts, styles, navigation, headers/footers from an HTML string,
 * and extracts sanitized plain text body.
 */
export function extractTextFromHtml(html: string, maxLength = 3000): string {
  if (!html) return '';

  let cleanHtml = html;

  // 1. Remove comments
  cleanHtml = cleanHtml.replace(/<!--[\s\S]*?-->/g, ' ');

  // 2. Remove tags with content (<script>...</script>, <style>...</style>, etc.)
  for (const tag of STRIP_TAGS_WITH_CONTENT) {
    const pairedRegex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    cleanHtml = cleanHtml.replace(pairedRegex, ' ');
    const selfClosingRegex = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    cleanHtml = cleanHtml.replace(selfClosingRegex, ' ');
  }

  // 3. Add whitespace around newlines and block tag boundaries, then remove all remaining HTML tags
  cleanHtml = cleanHtml.replace(/<[^>]+>/g, ' ');

  // 4. Decode HTML entities
  const decoded = decodeHtmlEntities(cleanHtml);

  // 5. Normalize consecutive whitespace and trim
  const normalized = decoded.replace(/\s+/g, ' ').trim();

  // 6. Limit length
  return normalized.slice(0, maxLength);
}

/**
 * Safely builds an ExtractedPagePayload from an HTML string.
 * Works in all environments including Service Worker, Node, renderer without DOMParser.
 */
export function extractPagePayloadFromHtml(
  html: string,
  fallbackUrl: string = '',
  fallbackTitle: string = '',
  maxLength = 3000
): ExtractedPagePayload {
  const { title: extractedTitle, metaDescription } = extractMetaFromHtml(html);
  const textContent = extractTextFromHtml(html, maxLength);
  const title = extractedTitle || fallbackTitle;

  return {
    title,
    url: fallbackUrl,
    metaDescription,
    textContent,
    content: textContent
  };
}
