import db, { type Bookmark } from '../db';

interface FolderTreeNode {
  subfolders: Map<string, FolderTreeNode>;
  bookmarks: Bookmark[];
}

function buildFolderTree(bookmarks: Bookmark[]): FolderTreeNode {
  const root: FolderTreeNode = { subfolders: new Map(), bookmarks: [] };

  for (const b of bookmarks) {
    const rawPath = (b.folderPath || '').trim();
    if (!rawPath) {
      root.bookmarks.push(b);
      continue;
    }

    const segments = rawPath.split('/').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) {
      root.bookmarks.push(b);
      continue;
    }

    let currentNode = root;
    for (const seg of segments) {
      let next = currentNode.subfolders.get(seg);
      if (!next) {
        next = { subfolders: new Map(), bookmarks: [] };
        currentNode.subfolders.set(seg, next);
      }
      currentNode = next;
    }
    currentNode.bookmarks.push(b);
  }

  return root;
}

function renderTreeToNetscapeHtml(node: FolderTreeNode, indentLevel: number): string {
  const indent = '    '.repeat(indentLevel);
  let html = '';

  for (const [folderName, subfolder] of node.subfolders.entries()) {
    html += `${indent}<DT><H3>${escapeHtml(folderName)}</H3>\n`;
    html += `${indent}<DL><p>\n`;
    html += renderTreeToNetscapeHtml(subfolder, indentLevel + 1);
    html += `${indent}</DL><p>\n`;
  }

  for (const b of node.bookmarks) {
    const addDate = Math.floor((b.createdAt || Date.now()) / 1000);
    const modDate = Math.floor((b.modifiedAt || b.createdAt || Date.now()) / 1000);
    const tagsAttr = b.tags && b.tags.length > 0 ? ` TAGS="${escapeHtml(b.tags.join(','))}"` : '';
    html += `${indent}<DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${addDate}" LAST_MODIFIED="${modDate}"${tagsAttr}>${escapeHtml(b.title)}</A>\n`;
    if (b.description) {
      html += `${indent}<DD>${escapeHtml(b.description)}\n`;
    }
  }

  return html;
}

/**
 * Exports bookmarks in Netscape HTML format (browser standard import spec).
 */
export async function exportAsHtml(bookmarks?: Bookmark[]): Promise<string> {
  const list = bookmarks ?? (await db.bookmarks.toArray());
  const tree = buildFolderTree(list);

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and written by auto-generated tools.
     Do NOT edit! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>\n`;

  html += renderTreeToNetscapeHtml(tree, 1);
  html += `</DL><p>\n`;
  return html;
}

/**
 * Exports bookmarks in JSON backup format.
 */
export async function exportAsJson(bookmarks?: Bookmark[]): Promise<string> {
  const list = bookmarks ?? (await db.bookmarks.toArray());
  const data = {
    version: '1.0',
    exportedAt: Date.now(),
    bookmarks: list
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Exports bookmarks in CSV format.
 */
export async function exportAsCsv(bookmarks?: Bookmark[]): Promise<string> {
  const list = bookmarks ?? (await db.bookmarks.toArray());
  let csv = 'ID,Title,URL,Description,Folder,Tags,Visit Count,Created At,Modified At\n';

  for (const b of list) {
    const row = [
      b.id || '',
      b.title,
      b.url,
      b.description || '',
      b.folderPath || '',
      (b.tags || []).join(';'),
      b.visitCount || 0,
      new Date(b.createdAt).toISOString(),
      new Date(b.modifiedAt).toISOString()
    ];
    csv += row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
  }

  return csv;
}

/**
 * Saves exported file using browser downloads API.
 *
 * Non-ASCII (Korean, etc.) filename pitfall (measured on 2026-08-11):
 * - `chrome.downloads.download` filename validation (`net::IsSafePortableRelativePath`)
 *   rejects non-ASCII characters with "Invalid filename".
 * - Anchor `a.download` silently ignores non-ASCII filenames and saves with default blob URL name
 *   ("download", without extension).
 * Therefore, ① attempt API with original filename → ② retry with ASCII-safe filename on failure →
 * ③ use ASCII-safe filename for anchor fallback from the beginning in environments without downloads API support.
 */
export async function downloadFile(content: string, filename: string, mimeType: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    if (typeof browser !== 'undefined' && browser.downloads) {
      try {
        await browser.downloads.download({ url, filename, saveAs: false });
        return;
      } catch (e) {
        console.warn('[downloadFile] downloads API rejected filename — retrying with ASCII safe name:', e);
      }
      const safeFilename = toSafeAsciiFilename(filename);
      try {
        await browser.downloads.download({ url, filename: safeFilename, saveAs: false });
        return;
      } catch (e) {
        console.warn('[downloadFile] ASCII safe filename also failed — falling back to anchor download:', e);
      }
    }

    // Fallback for environments without downloads API support (popup/management page, etc.).
    // Anchor ignores non-ASCII filenames, so use ASCII-safe name from the start.
    const a = document.createElement('a');
    a.href = url;
    a.download = toSafeAsciiFilename(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Do not revoke blob URL immediately as it may cause download data fetch to fail.
    // Blob URL is garbage collected when the page lifecycle ends.
  }
}

/**
 * Sanitizes filename to an ASCII filename that download API/anchor can safely handle.
 * Strips/replaces non-ASCII characters, OS-forbidden characters (`\/:*?"<>|%`), and whitespace;
 * replaces with `archive_<timestamp>` if the resulting string is empty (e.g. title is entirely non-ASCII).
 * Preserves extensions (.html, etc.).
 */
export function toSafeAsciiFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot) : '';
  let base = (dot > 0 ? filename.slice(0, dot) : filename)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/:*?"<>|%]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  if (!base) base = `archive_${Date.now()}`;
  const safeExt = ext
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/:*?"<>|%]+/g, '');
  return safeExt && safeExt !== '.' ? base + safeExt : base;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
