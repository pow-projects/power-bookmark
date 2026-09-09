import db from '../db';

export interface ConflictLog {
  id: string;
  status: 'pending' | 'resolved';
  autoResolvedTo: 'local' | 'cloud';
  userAction?: 'keep-local' | 'keep-cloud' | 'manual-edit';
  localVersion: {
    syncId?: string;
    bookmarkId?: string;
    title: string;
    url: string;
    description?: string;
    folderPath?: string;
    tags?: string[];
    modifiedAt: number;
  };
  cloudVersion: {
    syncId?: string;
    bookmarkId?: string;
    title: string;
    url: string;
    description?: string;
    folderPath?: string;
    tags?: string[];
    modifiedAt: number;
  };
  bookmarkId: string;
  timestamp: number;
}

export type UserAction = 'keep-local' | 'keep-cloud' | 'manual-edit';

export async function getPendingConflicts(): Promise<ConflictLog[]> {
  const logs = (await db.settings.get('sync_conflict_logs'))?.value || [];
  const pendingLogs = logs.filter((log: any) => {
    // legacy logs without status are considered resolved
    if (!log.status) return false;
    return log.status === 'pending';
  });

  // Deduplicate same bookmarkId (syncId) — return only 1 latest (first) log
  const seenBookmarkIds = new Set<string>();
  const uniquePending: ConflictLog[] = [];
  for (const log of pendingLogs) {
    const key = log.bookmarkId || log.localVersion?.syncId || log.id;
    if (!seenBookmarkIds.has(key)) {
      seenBookmarkIds.add(key);
      uniquePending.push(log);
    }
  }
  return uniquePending;
}

export async function resolveConflict(id: string, action: UserAction): Promise<void> {
  const logs = (await db.settings.get('sync_conflict_logs'))?.value || [];
  const logIndex = logs.findIndex((l: any) => l.id === id);
  if (logIndex !== -1) {
    logs[logIndex].status = 'resolved';
    logs[logIndex].userAction = action;
    await db.settings.put({ key: 'sync_conflict_logs', value: logs });
  }
}

export async function resolveBatchConflicts(
  resolutions: { id: string; action: UserAction }[] | Record<string, UserAction>
): Promise<void> {
  const logs = (await db.settings.get('sync_conflict_logs'))?.value || [];
  const resolutionMap = new Map<string, UserAction>();
  if (Array.isArray(resolutions)) {
    for (const r of resolutions) {
      resolutionMap.set(r.id, r.action);
    }
  } else {
    for (const [id, action] of Object.entries(resolutions)) {
      resolutionMap.set(id, action);
    }
  }

  let changed = false;
  for (let i = 0; i < logs.length; i++) {
    const action = resolutionMap.get(logs[i].id);
    if (action !== undefined && logs[i].status === 'pending') {
      logs[i].status = 'resolved';
      logs[i].userAction = action;
      changed = true;
    }
  }

  if (changed) {
    await db.settings.put({ key: 'sync_conflict_logs', value: logs });
  }
}

export async function resolveAllConflicts(action: 'keep-local' | 'keep-cloud'): Promise<void> {
  const logs = (await db.settings.get('sync_conflict_logs'))?.value || [];
  let changed = false;
  
  for (let i = 0; i < logs.length; i++) {
    if (logs[i].status === 'pending') {
      logs[i].status = 'resolved';
      logs[i].userAction = action;
      changed = true;
    }
  }
  
  if (changed) {
    await db.settings.put({ key: 'sync_conflict_logs', value: logs });
  }
}

export async function hasPendingConflicts(): Promise<boolean> {
  const logs = await getPendingConflicts();
  return logs.length > 0;
}

export async function clearResolvedLogs(): Promise<void> {
  const logs = (await db.settings.get('sync_conflict_logs'))?.value || [];
  const pendingLogs = logs.filter((log: any) => log.status === 'pending');
  await db.settings.put({ key: 'sync_conflict_logs', value: pendingLogs });
}
