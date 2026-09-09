import db from '../db';
import { BookmarkManager } from './bookmark-manager';
import { SyncEngine } from '../sync/sync-engine';
import { sanitizeTags } from './tag-utils';

export interface ImportedBookmark {
  url: string;
  title: string;
  description: string;
  folderPath?: string;
  tags?: string[];
  createdAt: number;
  modifiedAt: number;
}

/**
 * Decodes HTML character entities (&amp;, &lt;, &gt;, &quot;, &#039;, &#39;, &nbsp;, decimal/hexadecimal entities).
 */
export function unescapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Parses bookmarks in Netscape HTML format.
 * Handles folder hierarchy (<H3>, <DL>, </DL>), tags (TAGS="..."), timestamps, and HTML entities.
 */
export function parseNetscapeHtml(htmlContent: string): ImportedBookmark[] {
  const imported: ImportedBookmark[] = [];
  const folderStack: string[] = [];
  const dlStack: boolean[] = [];
  let pendingFolder: string | null = null;
  let currentBookmark: ImportedBookmark | null = null;

  // Tag token matching: <H3>...</H3>, <A ...>...</A>, <DD>..., <DL>, </DL>
  const tokenRegex = /<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>|<DD\b[^>]*>([\s\S]*?)(?=(?:<DT\b|<DL\b|<\/DL\b|<H3\b|<A\b|$))|<DL\b[^>]*>|<\/DL\b[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(htmlContent)) !== null) {
    const fullMatch = match[0];

    if (/^<H3/i.test(fullMatch)) {
      pendingFolder = unescapeHtml((match[1] || '').trim());
    } else if (/^<DL/i.test(fullMatch)) {
      if (pendingFolder) {
        folderStack.push(pendingFolder);
        dlStack.push(true);
        pendingFolder = null;
      } else {
        dlStack.push(false);
      }
    } else if (/^<\/DL/i.test(fullMatch)) {
      if (dlStack.pop()) {
        folderStack.pop();
      }
    } else if (/^<A/i.test(fullMatch)) {
      const attrs = match[2] || '';
      const rawTitle = match[3] || '';

      const hrefMatch = attrs.match(/HREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const rawUrl = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
      const url = unescapeHtml(rawUrl.trim());
      if (!url) continue;

      const title = unescapeHtml(rawTitle.trim());

      const dateMatch = attrs.match(/ADD_DATE\s*=\s*(?:"([^"]*)"|'([^']*)'|(\d+))/i);
      const modMatch = attrs.match(/LAST_MODIFIED\s*=\s*(?:"([^"]*)"|'([^']*)'|(\d+))/i);
      const tagsMatch = attrs.match(/TAGS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);

      const addDateVal = dateMatch ? (dateMatch[1] ?? dateMatch[2] ?? dateMatch[3]) : null;
      const modDateVal = modMatch ? (modMatch[1] ?? modMatch[2] ?? modMatch[3]) : null;

      const createdAt = addDateVal ? Number(addDateVal) * 1000 : Date.now();
      const modifiedAt = modDateVal ? Number(modDateVal) * 1000 : createdAt;

      const rawTags = tagsMatch ? unescapeHtml(tagsMatch[1] ?? tagsMatch[2] ?? tagsMatch[3] ?? '') : '';
      const sanitized = rawTags ? sanitizeTags(rawTags.split(/[,;]/)) : [];
      const tags = sanitized.length > 0 ? sanitized : undefined;

      const folderPath = folderStack.length > 0 ? folderStack.join('/') : '';

      currentBookmark = {
        url,
        title,
        description: '',
        folderPath: folderPath || undefined,
        tags,
        createdAt,
        modifiedAt
      };
      imported.push(currentBookmark);
    } else if (/^<DD/i.test(fullMatch) && currentBookmark) {
      const desc = unescapeHtml((match[4] || '').trim());
      currentBookmark.description = desc;
    }
  }

  return imported;
}

/**
 * Parses bookmark content in JSON backup format.
 */
export function parseJsonBookmarks(jsonContent: string): ImportedBookmark[] {
  const data = JSON.parse(jsonContent);
  const rawList: any[] = Array.isArray(data) ? data : (Array.isArray(data?.bookmarks) ? data.bookmarks : []);

  const imported: ImportedBookmark[] = [];
  for (const item of rawList) {
    if (!item || !item.url) continue;
    const itemTags = Array.isArray(item.tags) ? sanitizeTags(item.tags) : undefined;
    imported.push({
      url: String(item.url),
      title: String(item.title || ''),
      description: String(item.description || ''),
      folderPath: item.folderPath ? String(item.folderPath) : undefined,
      tags: itemTags && itemTags.length > 0 ? itemTags : undefined,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      modifiedAt: typeof item.modifiedAt === 'number' ? item.modifiedAt : Date.now()
    });
  }
  return imported;
}

/**
 * Batch creates bookmarks in browser and internal DB based on parsed list (skip duplicates and folder caching).
 */
export async function importBookmarks(parsedList: ImportedBookmark[]): Promise<{ imported: number; skipped: number }> {
  let importedCount = 0;
  let skippedCount = 0;

  const folderIdCache = new Map<string, string>();

  BookmarkManager.setSyncMuted(true);
  try {
    for (const item of parsedList) {
      try {
        if (!item.url) {
          skippedCount++;
          continue;
        }

        const duplicate = await BookmarkManager.findDuplicate(item.url);
        if (duplicate) {
          skippedCount++;
          continue;
        }

        let parentId: string | undefined;
        if (item.folderPath) {
          const cachedId = folderIdCache.get(item.folderPath);
          if (cachedId) {
            parentId = cachedId;
          } else {
            const ensured = await BookmarkManager.ensureFolderPath(item.folderPath);
            if (ensured?.id) {
              parentId = ensured.id;
              folderIdCache.set(item.folderPath, ensured.id);
            }
          }
        }

        await BookmarkManager.createBookmark(
          item.url,
          item.title,
          parentId,
          item.description,
          { createdAt: item.createdAt, modifiedAt: item.modifiedAt },
          item.tags
        );
        importedCount++;
      } catch (e) {
        console.error('[importBookmarks] Failed to import:', item.url, e);
        skippedCount++;
      }
    }
  } finally {
    BookmarkManager.setSyncMuted(false);
    // Background triggerSync events were suppressed while muted (mid-import sync races permanent
    // tombstones against freshly re-registered rows) — schedule the post-import cloud sync explicitly.
    SyncEngine.triggerDebouncedSync();
  }

  return { imported: importedCount, skipped: skippedCount };
}

/**
 * Imports bookmarks from an HTML file.
 */
export async function importFromHtml(htmlContent: string): Promise<{ imported: number; skipped: number }> {
  const parsedList = parseNetscapeHtml(htmlContent);
  return importBookmarks(parsedList);
}

/**
 * Imports bookmarks from a JSON file.
 */
export async function importFromJson(jsonContent: string): Promise<{ imported: number; skipped: number }> {
  const parsedList = parseJsonBookmarks(jsonContent);
  return importBookmarks(parsedList);
}

/**
 * RFC 4180-compliant zero-dependency character-by-character CSV parser.
 * Supports: quoted fields, multiline cells (\r\n, \n, \r), escaped quotes (""),
 * tolerance for unquoted quotes mid-field, trimming trailing newlines,
 * skipping empty/whitespace-only rows, and unclosed quote graceful EOF flush.
 */
export function parseCsv(text: string): string[][] {
  if (!text) return [];

  // Strip UTF-8 BOM if present
  const input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && input[i + 1] === '"') {
          // Escaped quote: "" -> "
          currentField += '"';
          i++;
        } else {
          // Check if this quote closes the field
          let j = i + 1;
          while (j < len && (input[j] === ' ' || input[j] === '\t')) j++;
          if (j === len || input[j] === ',' || input[j] === '\r' || input[j] === '\n') {
            inQuotes = false;
            i = j - 1; // advance i to right before delimiter/newline/EOF
          } else {
            // Unescaped quote mid-field tolerance inside quoted string
            currentField += '"';
          }
        }
      } else if (char === '\r') {
        if (i + 1 < len && input[i + 1] === '\n') {
          currentField += '\r\n';
          i++;
        } else {
          currentField += '\r';
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        if (currentField.trim() === '') {
          // Opening quote for quoted field (discard any leading spaces before quote)
          inQuotes = true;
          currentField = '';
        } else {
          // Tolerance for unquoted quote mid-field
          currentField += '"';
        }
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && i + 1 < len && input[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.some(cell => cell.trim() !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  // Graceful EOF flush (handles unclosed quote as well)
  currentRow.push(currentField);
  if (currentRow.some(cell => cell.trim() !== '')) {
    rows.push(currentRow);
  }

  return rows;
}

const URL_ALIASES = new Set(['url', 'link', 'href', 'address', 'target', 'uri', 'bookmarkurl', 'website']);
const TITLE_ALIASES = new Set(['title', 'name', 'bookmarkname', 'pagetitle']);
const DESC_ALIASES = new Set(['description', 'desc', 'note', 'notes', 'comment', 'comments', 'excerpt', 'memo']);
const FOLDER_ALIASES = new Set(['folder', 'folderpath', 'folders', 'directory', 'category', 'path']);
const TAGS_ALIASES = new Set(['tags', 'tag', 'labels', 'label', 'keywords']);
const CREATED_ALIASES = new Set(['createdat', 'created', 'creationdate', 'dateadded', 'date_added', 'added']);
const MODIFIED_ALIASES = new Set(['modifiedat', 'modified', 'lastmodified', 'updated', 'updatedat']);

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function parseCsvDate(val: string | undefined, fallback: number): number {
  if (!val || val.trim() === '') return fallback;
  const trimmed = val.trim();
  const num = Number(trimmed);
  if (!isNaN(num) && isFinite(num)) {
    return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
  }
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) return parsed;
  return fallback;
}

/**
 * Parses bookmark content from a CSV string.
 * Resolves column headers flexibly, sanitizes URLs, and extracts metadata.
 */
export function parseCsvBookmarks(csvContent: string): ImportedBookmark[] {
  const rows = parseCsv(csvContent);
  if (rows.length === 0) {
    throw new Error('No URL column found in CSV');
  }

  const headers = rows[0];
  let urlCol = -1;
  let titleCol = -1;
  let descCol = -1;
  let folderCol = -1;
  let tagsCol = -1;
  let createdCol = -1;
  let modifiedCol = -1;

  for (let i = 0; i < headers.length; i++) {
    const raw = headers[i].trim().toLowerCase();
    const norm = normalizeHeader(headers[i]);

    if (urlCol === -1 && (URL_ALIASES.has(norm) || URL_ALIASES.has(raw))) urlCol = i;
    else if (titleCol === -1 && (TITLE_ALIASES.has(norm) || TITLE_ALIASES.has(raw))) titleCol = i;
    else if (descCol === -1 && (DESC_ALIASES.has(norm) || DESC_ALIASES.has(raw))) descCol = i;
    else if (folderCol === -1 && (FOLDER_ALIASES.has(norm) || FOLDER_ALIASES.has(raw))) folderCol = i;
    else if (tagsCol === -1 && (TAGS_ALIASES.has(norm) || TAGS_ALIASES.has(raw))) tagsCol = i;
    else if (createdCol === -1 && (CREATED_ALIASES.has(norm) || CREATED_ALIASES.has(raw))) createdCol = i;
    else if (modifiedCol === -1 && (MODIFIED_ALIASES.has(norm) || MODIFIED_ALIASES.has(raw))) modifiedCol = i;
  }

  if (urlCol === -1) {
    throw new Error('No URL column found in CSV');
  }

  const imported: ImportedBookmark[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    let rawUrl = (row[urlCol] ?? '').trim();
    if (!rawUrl) continue;

    const lowerUrl = rawUrl.toLowerCase();
    if (lowerUrl.startsWith('javascript:') || lowerUrl.startsWith('data:')) {
      continue;
    }

    if (rawUrl.startsWith('//')) {
      rawUrl = 'https:' + rawUrl;
    } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
      rawUrl = 'https://' + rawUrl;
    }

    const rawTitle = titleCol !== -1 ? (row[titleCol] ?? '').trim() : '';
    const title = rawTitle || rawUrl;
    const description = descCol !== -1 ? (row[descCol] ?? '').trim() : '';

    let folderPath: string | undefined;
    if (folderCol !== -1) {
      const rawFolder = (row[folderCol] ?? '').trim();
      const trimmed = rawFolder.replace(/^\/+|\/+$/g, '').trim();
      if (trimmed) {
        folderPath = trimmed;
      }
    }

    let tags: string[] | undefined;
    if (tagsCol !== -1) {
      const rawTags = (row[tagsCol] ?? '').trim();
      if (rawTags) {
        const split = rawTags.split(/[,;|]/);
        const sanitized = sanitizeTags(split);
        if (sanitized.length > 0) {
          tags = sanitized;
        }
      }
    }

    const now = Date.now();
    const createdAt = parseCsvDate(createdCol !== -1 ? row[createdCol] : undefined, now);
    const modifiedAt = parseCsvDate(modifiedCol !== -1 ? row[modifiedCol] : undefined, createdAt);

    imported.push({
      url: rawUrl,
      title,
      description,
      folderPath,
      tags,
      createdAt,
      modifiedAt
    });
  }

  return imported;
}

/**
 * Imports bookmarks from a CSV file.
 */
export async function importFromCsv(csvContent: string): Promise<{ imported: number; skipped: number }> {
  const parsedList = parseCsvBookmarks(csvContent);
  return importBookmarks(parsedList);
}

