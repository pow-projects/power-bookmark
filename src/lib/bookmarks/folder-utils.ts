export const SYSTEM_ROOT_NAMES = new Set<string>([
  'bookmarks bar',
  'other bookmarks',
  'bookmarks menu',
  'mobile bookmarks',
  'bookmarks toolbar',
  'unfiled bookmarks',
  '북마크바',
  '북마크 바',
  '기타 북마크',
  '기타북마크',
  '모바일 북마크',
  '모바일북마크',
  '북마크 메뉴',
  '북마크메뉴',
  '북마크 도구모음',
  '북마크 도구 모음',
]);

/** Determines whether the given title is a browser system root folder name (Bookmarks bar, Other bookmarks, etc.) (trim + case-insensitive match) */
export function isSystemRootTitle(title?: string): boolean {
  return SYSTEM_ROOT_NAMES.has((title || '').trim().toLowerCase());
}

/** Minimal structure of folder item used by resolveSuggestedFolder and getRootFolderName (compatible with both FolderItem and FolderInfo) */
export interface ResolvedFolderInput {
  id: string;
  title: string;
  path?: string;
  displayName?: string;
}

/**
 * Determines the root folder name (Bookmarks bar, Other bookmarks, Mobile bookmarks, etc.) that the bookmark belongs to from folderPath or the folders list.
 * Returns the matching root name if the first segment of the path is a system root name or matches a root name in the folders tree,
 * or returns the default 'Bookmarks bar' if empty or unmatched.
 */
export function getRootFolderName(folderPath?: string, folders?: ResolvedFolderInput[]): string {
  const trimmed = (folderPath || '').trim();
  if (!trimmed) {
    const bar = folders?.find(f => f.title && f.title.toLowerCase() === 'bookmarks bar')
      ?? folders?.find(f => f.title && SYSTEM_ROOT_NAMES.has(f.title.toLowerCase()));
    return bar ? bar.title : 'Bookmarks bar';
  }

  const firstSeg = trimmed.split('/')[0]?.trim();
  if (!firstSeg) {
    return 'Bookmarks bar';
  }

  // 1. Check if there is a root folder in folders matching firstSeg
  if (folders && folders.length > 0) {
    const matchedRoot = folders.find(f => {
      const isRoot = !f.path || !f.path.includes('/') || f.path === f.title || SYSTEM_ROOT_NAMES.has((f.path || '').toLowerCase()) || SYSTEM_ROOT_NAMES.has(f.title.toLowerCase());
      if (!isRoot) return false;
      return f.title.toLowerCase() === firstSeg.toLowerCase() || (f.path && f.path.toLowerCase() === firstSeg.toLowerCase());
    });
    if (matchedRoot) {
      return matchedRoot.title;
    }
  }

  // 2. Check if included in SYSTEM_ROOT_NAMES
  if (SYSTEM_ROOT_NAMES.has(firstSeg.toLowerCase())) {
    return firstSeg;
  }

  return 'Bookmarks bar';
}

/**
 * 'Bookmarks bar/Community' → 'Community' — removes system root folder name from path.
 * Used when comparing AI suggested folder path ("Community/Politics") against the actual folder path.
 */
export function normalizeFolderPath(path?: string): string {
  return (path || '')
    .split('/')
    .filter(seg => seg && !SYSTEM_ROOT_NAMES.has(seg.toLowerCase()))
    .join('/');
}

/**
 * Compares whether two folder paths refer to the same actual location.
 * Checks both the system root (Bookmarks bar vs Other bookmarks) and the normalized subpath,
 * accurately detecting cross-root moves (Bookmarks bar → Other bookmarks) while treating
 * legacy missing prefixes ("Development" vs "Bookmarks bar/Development") as the same location.
 */
export function isSameFolderLocation(pathA?: string, pathB?: string, folders?: ResolvedFolderInput[]): boolean {
  const normA = normalizeFolderPath(pathA);
  const normB = normalizeFolderPath(pathB);
  if (normA !== normB) return false;

  const rootA = getRootFolderName(pathA, folders);
  const rootB = getRootFolderName(pathB, folders);
  return rootA.toLowerCase() === rootB.toLowerCase();
}

/**
 * Uncategorized check = whether the bookmark is directly under a system root (Bookmarks bar / Other bookmarks, etc.).
 * Considered "directory unspecified" if the path is empty when folderPath is passed through normalizeFolderPath (system root stripped).
 * AI category field has been deprecated — determined solely by placement in a classification (directory).
 */
export function isUncategorizedBookmark(b: { folderPath?: string }): boolean {
  return !normalizeFolderPath(b.folderPath);
}

/**
 * Extracts only the leaf folder name excluding parent folders from the full folder path.
 * Example: 'Bookmarks bar/Development/Frontend' -> 'Frontend'
 */
export function getLeafFolderName(path?: string): string {
  if (!path) return '';
  const segments = path.split('/').map(seg => seg.trim()).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * Protects slashes inside common technical terms from being split into directory paths.
 * E.g., 'CDN/WAF' -> 'CDN-WAF', 'CI/CD' -> 'CI-CD', 'TCP/IP' -> 'TCP-IP', 'UI/UX' -> 'UI-UX'
 */
export function sanitizeTechnicalSlashes(name: string): string {
  if (!name) return '';
  return name.replace(/\b(CDN|CI|CD|TCP|IP|UI|UX|I|O|OS)\/(WAF|CD|IP|TCP|UX|UI|O|I|2)\b/gi, '$1-$2');
}

/**
 * Clamps folder path depth for newly recommended folders to prevent excessive nesting (e.g. max 3 levels: Large/Medium/Small).
 * E.g., 'AI/StableDiffusion/Webui/extensions' -> 'AI/StableDiffusion/Webui'
 * Preserves user's existing tree when not generating new paths.
 */
export function clampNewFolderDepth(path: string, maxDepth = 3): string {
  if (!path) return '';
  const segments = path.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length <= maxDepth) {
    return segments.join('/');
  }
  return segments.slice(0, maxDepth).join('/');
}

/**
 * Known model hallucinations / typos map to correct forms
 */
export const KNOWN_FOLDER_TYPOS: Record<string, string> = {
  'weggl': 'WebGL',
  'webgl': 'WebGL',
  '재태크': '재테크',
  'webui': 'WebUI',
};

/**
 * Generic leaf folder names that lack distinct domain specificity.
 * When suggested as a single word (depth === 1), matching against deep hierarchy (depth >= 2) is blocked.
 */
export const GENERIC_LEAF_NAMES = new Set<string>([
  'tools',
  'tool',
  'util',
  'utils',
  'misc',
  'general',
  'etc',
  'temp',
  'docs',
  'resources',
  'lib',
  'libraries',
  '자료',
  '도구',
  '기타',
  '일반',
]);

/**
 * Computes Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix: number[][] = [];
  for (let i = 0; i <= bn; i++) matrix[i] = [i];
  for (let j = 0; j <= an; j++) matrix[0][j] = j;

  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[bn][an];
}

/**
 * Checks if two strings are a safe typo match (min length >= 4, Levenshtein <= 1, similarity >= 0.8)
 */
function isTypoMatch(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const similarity = 1 - dist / maxLen;
  return dist <= 1 && similarity >= 0.8;
}

/**
 * Searches for a fuzzy or typo-matched folder in the existing folder list.
 * Applies safety guardrails: min length >= 4, Levenshtein distance <= 1, similarity >= 0.8,
 * strict parent path preservation for multi-level paths, and deep match blocking for generic leaf names.
 */
export function findFuzzyMatchingFolder(
  candidatePath: string,
  folders: ResolvedFolderInput[]
): ResolvedFolderInput | undefined {
  if (!candidatePath || !folders || folders.length === 0) return undefined;
  const normCandidate = normalizeFolderPath(candidatePath).trim().toLowerCase();
  if (!normCandidate) return undefined;

  const candSegments = normCandidate.split('/').filter(Boolean);
  const candDepth = candSegments.length;
  if (candDepth === 0) return undefined;

  // 1. candDepth >= 2 (Hierarchical path, e.g. "AI/Tools", "개발/Tools")
  if (candDepth >= 2) {
    const candParent = candSegments.slice(0, -1).join('/');
    const leafCandidate = candSegments[candSegments.length - 1];
    const correctedLeaf = KNOWN_FOLDER_TYPOS[leafCandidate]?.toLowerCase();

    // Verify folder invariant: fSegments.length === candDepth and fParent === candParent
    const sameParentFolders: { folder: ResolvedFolderInput; fLeaf: string }[] = [];
    for (const f of folders) {
      const normF = normalizeFolderPath(f.path || f.title).trim().toLowerCase();
      const fSegments = normF.split('/').filter(Boolean);
      if (fSegments.length !== candDepth) continue;
      const fParent = fSegments.slice(0, -1).join('/');
      if (fParent !== candParent) continue;
      sameParentFolders.push({ folder: f, fLeaf: fSegments[fSegments.length - 1] });
    }

    const exactMatch = sameParentFolders.find(
      item => item.fLeaf === leafCandidate || (correctedLeaf != null && item.fLeaf === correctedLeaf)
    );
    if (exactMatch) return exactMatch.folder;

    const fuzzyMatch = sameParentFolders.find(
      item => isTypoMatch(leafCandidate, item.fLeaf)
    );
    if (fuzzyMatch) return fuzzyMatch.folder;

    return undefined;
  }

  // 2. candDepth === 1 (Single-word path, e.g. "Tools", "WebGL")
  const leafCandidate = candSegments[0];
  const correctedLeaf = KNOWN_FOLDER_TYPOS[leafCandidate]?.toLowerCase();

  // 1차: 루트 직속 단일 레벨 폴더 (fSegments.length === 1) 우선 매칭
  const singleLevelFolders: { folder: ResolvedFolderInput; fLeaf: string }[] = [];
  for (const f of folders) {
    const normF = normalizeFolderPath(f.path || f.title).trim().toLowerCase();
    const fSegments = normF.split('/').filter(Boolean);
    if (fSegments.length === 1) {
      singleLevelFolders.push({ folder: f, fLeaf: fSegments[0] });
    }
  }

  const exactSingle = singleLevelFolders.find(
    item => item.fLeaf === leafCandidate || (correctedLeaf != null && item.fLeaf === correctedLeaf)
  );
  if (exactSingle) return exactSingle.folder;

  const fuzzySingle = singleLevelFolders.find(
    item => isTypoMatch(leafCandidate, item.fLeaf)
  );
  if (fuzzySingle) return fuzzySingle.folder;

  // 2차: GENERIC_LEAF_NAMES에 포함된 경우 깊은 계층 (depth >= 2) 매칭 전면 차단
  if (GENERIC_LEAF_NAMES.has(leafCandidate) || (correctedLeaf != null && GENERIC_LEAF_NAMES.has(correctedLeaf))) {
    return undefined;
  }

  // 3차: 비범용 고유 도메인 명사(WebGL, Javascript 등)인 경우 트리 전체에서 유일한 매칭 노드일 때 깊은 계층 매칭 허용
  const deepFolders: { folder: ResolvedFolderInput; fLeaf: string }[] = [];
  for (const f of folders) {
    const normF = normalizeFolderPath(f.path || f.title).trim().toLowerCase();
    const fSegments = normF.split('/').filter(Boolean);
    if (fSegments.length >= 2) {
      deepFolders.push({ folder: f, fLeaf: fSegments[fSegments.length - 1] });
    }
  }

  const exactDeepMatches = deepFolders.filter(
    item => item.fLeaf === leafCandidate || (correctedLeaf != null && item.fLeaf === correctedLeaf)
  );
  if (exactDeepMatches.length === 1) {
    return exactDeepMatches[0].folder;
  }
  if (exactDeepMatches.length > 1) {
    return undefined;
  }

  const fuzzyDeepMatches = deepFolders.filter(
    item => isTypoMatch(leafCandidate, item.fLeaf)
  );
  if (fuzzyDeepMatches.length === 1) {
    return fuzzyDeepMatches[0].folder;
  }

  return undefined;
}

