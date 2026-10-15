/**
 * Typed contracts for Incognito mode IPC communication between Incognito context (Popup)
 * and primary profile context (Background Service Worker).
 */

export interface CheckDuplicateBookmarkRequest {
  type: 'CHECK_DUPLICATE_BOOKMARK';
  url: string;
}

export interface CheckDuplicateBookmarkResponse {
  duplicate: boolean;
  bookmark?: {
    id: number;
    syncId: string;
    bookmarkId: string;
    title: string;
    folderPath?: string;
    tags?: string[];
    description?: string;
    createdAt: number;
    modifiedAt: number;
  } | null;
}

export interface RegisterIncognitoBookmarkRequest {
  type: 'REGISTER_INCOGNITO_BOOKMARK';
  syncId: string;
  browserBookmarkId: string;
  url: string;
  title: string;
  folderPath?: string;
  description?: string;
  tags?: string[];
  createdAt?: number;
  modifiedAt?: number;
}

export interface RegisterIncognitoBookmarkResponse {
  ok: boolean;
  dbId?: number;
  syncId: string;
  error?: string;
}

export interface GetTagSuggestionsRequest {
  type: 'GET_TAG_SUGGESTIONS';
}

export interface GetTagSuggestionsResponse {
  tags: string[];
}

export interface CreateIncognitoBookmarkRequest {
  type: 'CREATE_INCOGNITO_BOOKMARK';
  url: string;
  title: string;
  parentId?: string;
  folderPath?: string;
  description?: string;
  tags?: string[];
}

export interface CreateIncognitoBookmarkResponse {
  ok: boolean;
  bookmarkId?: number;
  browserBookmarkId?: string;
  syncId?: string;
  error?: string;
}
