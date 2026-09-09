import { BookmarkManager } from './bookmark-manager';

export const BOOKMARK_BADGE_TEXT = '🔖';
export type IconPathMap = Record<string, string>;

export const DEFAULT_ICON_PATH: IconPathMap = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

export const ACTIVE_ICON_PATH: IconPathMap = {
  '16': 'icons/icon-active-16.png',
  '32': 'icons/icon-active-32.png',
  '48': 'icons/icon-active-48.png',
  '128': 'icons/icon-active-128.png',
};

export const SPINNER_ICON_PATHS: IconPathMap[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
  '16': `icons/spinner-${i}-16.png`,
  '32': `icons/spinner-${i}-32.png`,
  '48': `icons/spinner-${i}-48.png`,
  '128': `icons/spinner-${i}-128.png`,
}));

export const SPINNER_FRAMES = SPINNER_ICON_PATHS;
export const SPINNER_INTERVAL_MS = 120;
export const COLOR_PRIMARY = '#D6453D'; // Ribbon Red (--color-primary)
export const COLOR_AI = '#0F766E'; // Stamp Teal (--color-accent / --color-success)

export type TaskType = 'archive' | 'ai' | 'sync' | 'capture';

const taskCounts: Record<TaskType, number> = {
  archive: 0,
  ai: 0,
  sync: 0,
  capture: 0,
};

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let currentFrameIndex = 0;

/**
 * Normalizes URL to improve duplicate determination and detection accuracy.
 * - Removes trailing slash (/) (retaining root path)
 * - Sorts query parameters and lowercases host
 */
export function normalizeUrl(url: string): string {
  if (!url) return '';
  let cleaned = url.trim();
  try {
    const parsed = new URL(cleaned);
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const searchParams = new URLSearchParams(parsed.search);
    const keys = Array.from(new Set(searchParams.keys())).sort();
    const sortedParams = new URLSearchParams();
    for (const key of keys) {
      const values = searchParams.getAll(key).sort();
      for (const val of values) {
        sortedParams.append(key, val);
      }
    }
    const search = sortedParams.toString() ? `?${sortedParams.toString()}` : '';
    const port =
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
        ? ''
        : parsed.port;
    const portSuffix = port ? `:${port}` : '';

    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${portSuffix}${pathname}${search}${parsed.hash}`;
  } catch (e) {
    if (cleaned.length > 1 && cleaned.endsWith('/')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned.toLowerCase();
  }
}

function getActionApi() {
  if (typeof browser === 'undefined') return undefined;
  return browser.action || (browser as any).browserAction;
}

/**
 * Checks if tab URL is registered in DB bookmarks and updates extension Badge, Title, and Icon.
 * @param tabId Target tab ID to update
 * @param url (optional) Tab URL (resolved via browser.tabs.get if omitted)
 */
export async function updateActionBadge(tabId: number, url?: string): Promise<void> {
  if (!tabId) return;

  const actionApi = getActionApi();
  if (!actionApi) return;

  const totalTasks = taskCounts.archive + taskCounts.ai + taskCounts.sync + taskCounts.capture;
  if (totalTasks > 0) {
    // When active task indicator (spinner) is in progress, set spinner icon and title without background
    const { title } = getTaskIndicatorMeta();
    const iconPath = SPINNER_ICON_PATHS[currentFrameIndex] || SPINNER_ICON_PATHS[0];
    await actionApi.setBadgeText({ tabId, text: '' }).catch(() => {});
    await actionApi.setTitle({ tabId, title }).catch(() => {});
    await actionApi.setIcon({ tabId, path: iconPath }).catch(() => {});
    return;
  }

  if (!url) {
    try {
      const tab = await browser?.tabs?.get(tabId);
      url = tab?.url;
    } catch {
      return;
    }
  }

  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('moz-extension://')) {
    await actionApi.setBadgeText({ tabId, text: '' }).catch(() => {});
    await actionApi.setTitle({ tabId, title: 'PowerBookmark' }).catch(() => {});
    try {
      await actionApi.setIcon({
        tabId,
        path: DEFAULT_ICON_PATH,
      });
    } catch {
      // ignore
    }
    return;
  }

  try {
    const normalizedUrl = normalizeUrl(url);
    const isBookmarked = !!(await BookmarkManager.findDuplicate(normalizedUrl));
    if (isBookmarked) {
      await actionApi.setBadgeText({ tabId, text: '' }).catch(() => {});
      await actionApi.setTitle({ tabId, title: i18n.t('badge.saved') });
      try {
        await actionApi.setIcon({
          tabId,
          path: ACTIVE_ICON_PATH,
        });
      } catch {
        // ignore setIcon error
      }
    } else {
      await actionApi.setBadgeText({ tabId, text: '' }).catch(() => {});
      await actionApi.setTitle({ tabId, title: 'PowerBookmark' });
      try {
        await actionApi.setIcon({
          tabId,
          path: DEFAULT_ICON_PATH,
        });
      } catch {
        // ignore setIcon error
      }
    }
  } catch (e) {
    console.error('Failed to update action badge:', e);
  }
}

/**
 * Calculates metadata (title and badge background color) for active tasks.
 */
function getTaskIndicatorMeta(): { title: string; color: string } {
  const hasArchive = taskCounts.archive > 0;
  const hasAi = taskCounts.ai > 0;
  const hasSync = taskCounts.sync > 0;
  const hasCapture = taskCounts.capture > 0;
  const activeCount = (hasArchive ? 1 : 0) + (hasAi ? 1 : 0) + (hasSync ? 1 : 0) + (hasCapture ? 1 : 0);

  if (activeCount > 1) {
    return {
      title: i18n.t('badge.processing'),
      color: hasArchive || hasSync || hasCapture ? COLOR_PRIMARY : COLOR_AI,
    };
  }

  if (hasCapture) {
    return {
      title: i18n.t('badge.capturing'),
      color: COLOR_PRIMARY,
    };
  }

  if (hasArchive) {
    return {
      title: i18n.t('badge.archiving'),
      color: COLOR_PRIMARY,
    };
  }

  if (hasAi) {
    return {
      title: i18n.t('badge.aiAnalyzing'),
      color: COLOR_AI,
    };
  }

  if (hasSync) {
    return {
      title: i18n.t('badge.syncing'),
      color: COLOR_PRIMARY,
    };
  }

  return {
    title: 'PowerBookmark',
    color: COLOR_PRIMARY,
  };
}

/**
 * Synchronizes spinner frame and metadata across global and all open tabs.
 */
async function renderSpinnerFrame(iconPath: IconPathMap, title: string): Promise<void> {
  const actionApi = getActionApi();
  if (!actionApi) return;

  await Promise.all([
    actionApi.setBadgeText({ text: '' }).catch(() => {}),
    actionApi.setTitle({ title }).catch(() => {}),
    actionApi.setIcon({ path: iconPath }).catch(() => {}),
  ]);

  if (browser?.tabs?.query) {
    try {
      const tabs = await browser.tabs.query({});
      await Promise.allSettled(
        tabs.map((tab) => {
          if (typeof tab.id === 'number') {
            return Promise.all([
              actionApi.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}),
              actionApi.setTitle({ tabId: tab.id, title }).catch(() => {}),
              actionApi.setIcon({ tabId: tab.id, path: iconPath }).catch(() => {}),
            ]);
          }
        })
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Synchronizes spinner animation or badge restoration according to current taskCounts state.
 */
async function syncTaskIndicatorState(): Promise<void> {
  const actionApi = getActionApi();
  if (!actionApi) return;

  const totalTasks = taskCounts.archive + taskCounts.ai + taskCounts.sync + taskCounts.capture;

  if (totalTasks > 0) {
    const { title } = getTaskIndicatorMeta();

    if (!spinnerTimer) {
      currentFrameIndex = 0;
      await renderSpinnerFrame(SPINNER_ICON_PATHS[currentFrameIndex], title);
      spinnerTimer = setInterval(() => {
        currentFrameIndex = (currentFrameIndex + 1) % SPINNER_ICON_PATHS.length;
        const currentMeta = getTaskIndicatorMeta();
        renderSpinnerFrame(SPINNER_ICON_PATHS[currentFrameIndex], currentMeta.title).catch(() => {});
      }, SPINNER_INTERVAL_MS);
    } else {
      await renderSpinnerFrame(SPINNER_ICON_PATHS[currentFrameIndex], title);
    }
  } else {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    currentFrameIndex = 0;
    const { color } = getTaskIndicatorMeta();

    try {
      // Reset global badge, title, and default icon
      await actionApi.setBadgeText({ text: '' }).catch(() => {});
      await actionApi.setTitle({ title: 'PowerBookmark' }).catch(() => {});
      await actionApi.setIcon({ path: DEFAULT_ICON_PATH }).catch(() => {});

      // Traverse all active tabs and restore to original state in parallel
      if (browser.tabs && browser.tabs.query) {
        const tabs = await browser.tabs.query({});
        const activeTasksNow = taskCounts.archive + taskCounts.ai + taskCounts.sync + taskCounts.capture;
        if (activeTasksNow > 0) return; // Abort if a new task started during restoration

        await Promise.allSettled(
          tabs.map(async (tab) => {
            if (typeof tab.id === 'number') {
              await updateActionBadge(tab.id, tab.url);
            }
          })
        );
      }
    } catch (e) {
      console.error('Failed to restore action badge after task indicator:', e);
    }
  }
}

/**
 * Registers the start of a specific task (archive | ai | sync) and activates the spinner indicator.
 */
export async function startTaskIndicator(taskType: TaskType): Promise<void> {
  taskCounts[taskType] = (taskCounts[taskType] || 0) + 1;
  await syncTaskIndicatorState();
}

/**
 * Registers the end of a specific task (archive | ai | sync) and restores original badge once all tasks are complete.
 */
export async function endTaskIndicator(taskType: TaskType): Promise<void> {
  taskCounts[taskType] = Math.max(0, (taskCounts[taskType] || 0) - 1);
  await syncTaskIndicatorState();
}

/**
 * Sets integrated task indicator state.
 * @param taskType Task type ('archive' | 'ai' | 'sync')
 * @param active Whether task is active
 */
export async function setTaskIndicator(taskType: TaskType, active: boolean): Promise<void> {
  if (active) {
    await startTaskIndicator(taskType);
  } else {
    await endTaskIndicator(taskType);
  }
}

/**
 * Displays ongoing sync progress on extension button badge/title and restores original state upon completion (retains backwards compatibility).
 * @param syncing Whether sync is in progress
 */
export async function setSyncingIndicator(syncing: boolean): Promise<void> {
  return setTaskIndicator('sync', syncing);
}

/**
 * State reset helper for testing
 */
export function _resetTaskIndicatorsForTest(): void {
  taskCounts.archive = 0;
  taskCounts.ai = 0;
  taskCounts.sync = 0;
  taskCounts.capture = 0;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  currentFrameIndex = 0;
}

/**
 * Retrieves current active task counts (for testing and monitoring)
 */
export function getActiveTaskCounts(): Readonly<Record<TaskType, number>> {
  return { ...taskCounts };
}

/**
 * Checks whether spinner timer is running (for testing)
 */
export function isSpinnerRunning(): boolean {
  return spinnerTimer !== null;
}
