/**
 * Tag normalization and sanitization utilities.
 * Policy: Completely eliminates all whitespace within tags.
 */

/**
 * Sanitizes a single tag:
 * - Strips leading '#' characters
 * - Completely removes all whitespace (\s+)
 * - Returns string without whitespace
 */
export function sanitizeTag(tag: unknown): string {
  if (tag == null) return '';
  const str = String(tag).trim();
  return str.replace(/^#+/, '').replace(/\s+/g, '');
}

/**
 * Sanitizes an array of tags (or string input):
 * - Accepts string[] or comma/semicolon-delimited string
 * - Sanitizes each tag by stripping whitespace completely
 * - Filters out empty strings
 * - Deduplicates case-insensitively while preserving original casing of first occurrence
 */
export function sanitizeTags(tags: unknown): string[] {
  if (!tags) return [];

  let rawList: unknown[];
  if (Array.isArray(tags)) {
    rawList = tags;
  } else if (typeof tags === 'string') {
    rawList = tags.split(/[,;]/);
  } else {
    rawList = [tags];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of rawList) {
    const clean = sanitizeTag(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  }

  return result;
}
