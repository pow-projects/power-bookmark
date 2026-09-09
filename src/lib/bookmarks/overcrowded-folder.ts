import db, { type Bookmark } from '../db';
import type { FolderNode } from './bookmark-manager';

export const OVERCROWDED_FOLDER_THRESHOLD = 50;
export const NOTIFIED_OVERCROWDED_FOLDERS_KEY = 'notified_overcrowded_folders';

export interface OvercrowdedFolderInfo {
  folderPath: string;
  folderName: string;
  folderId?: string;
  count: number;
}

/**
 * Calculates bookmark counts per direct folder path and returns list of folders
 * reaching or exceeding OVERCROWDED_FOLDER_THRESHOLD that haven't been notified yet.
 */
export function findOvercrowdedFolders(
  bookmarks: Bookmark[],
  notifiedFolders: string[] = [],
  folders: FolderNode[] = [],
  threshold: number = OVERCROWDED_FOLDER_THRESHOLD
): OvercrowdedFolderInfo[] {
  if (!bookmarks || bookmarks.length === 0) return [];

  const counts = new Map<string, number>();
  for (const b of bookmarks) {
    const path = (b.folderPath || '').trim();
    if (!path) continue;
    counts.set(path, (counts.get(path) || 0) + 1);
  }

  const notifiedSet = new Set(notifiedFolders);
  const folderIdByPath = new Map<string, string>();
  for (const f of folders) {
    if (f.path && f.id) {
      folderIdByPath.set(f.path, f.id);
    }
  }

  const result: OvercrowdedFolderInfo[] = [];

  for (const [folderPath, count] of counts.entries()) {
    const folderId = folderIdByPath.get(folderPath);
    const isNotified =
      notifiedSet.has(folderPath) ||
      (folderId !== undefined && notifiedSet.has(folderId));

    if (count >= threshold && !isNotified) {
      const parts = folderPath.split('/').filter(Boolean);
      const folderName = parts.length > 0 ? parts[parts.length - 1] : folderPath;
      result.push({
        folderPath,
        folderName,
        folderId,
        count
      });
    }
  }

  return result.sort((a, b) => b.count - a.count);
}

/**
 * Retrieves the list of notified overcrowded folder paths/IDs from db.settings.
 */
export async function getNotifiedOvercrowdedFolders(): Promise<string[]> {
  try {
    if (typeof db === 'undefined' || !db.settings) return [];
    const record = await db.settings.get(NOTIFIED_OVERCROWDED_FOLDERS_KEY);
    return Array.isArray(record?.value) ? record.value : [];
  } catch (error) {
    console.error('Failed to get notified overcrowded folders:', error);
    return [];
  }
}

/**
 * Marks a folder path and optional folder ID as notified in db.settings (1-time notification).
 */
export async function markOvercrowdedFolderNotified(
  folderPath: string,
  folderId?: string
): Promise<void> {
  try {
    if (typeof db === 'undefined' || !db.settings || !folderPath) return;
    const existing = await getNotifiedOvercrowdedFolders();
    const updated = new Set(existing);
    if (folderPath) updated.add(folderPath);
    if (folderId) updated.add(folderId);

    await db.settings.put({
      key: NOTIFIED_OVERCROWDED_FOLDERS_KEY,
      value: Array.from(updated)
    });
  } catch (error) {
    console.error('Failed to mark overcrowded folder as notified:', error);
  }
}
