import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STALE_MS,
  claimArchiveUpload,
  markUploaded,
  markError,
  getUploadStateMap,
  notifyArchiveUploadUpdate,
  notifyArchiveUploadError
} from '../../src/lib/archive/archive-upload-state';

const { mockStorageSet, mockStorageGet, mockStorageRemove } = vi.hoisted(() => ({
  mockStorageSet: vi.fn(),
  mockStorageGet: vi.fn(),
  mockStorageRemove: vi.fn()
}));

function stubBrowserStorage() {
  const store: Record<string, unknown> = {};
  mockStorageSet.mockImplementation(async (obj: Record<string, unknown>) => Object.assign(store, obj));
  mockStorageGet.mockImplementation(async (key: string) => ({ [key]: store[key] }));
  mockStorageRemove.mockImplementation(async (key: string) => { delete store[key]; });
  vi.stubGlobal('browser', {
    storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } }
  });
}

describe('archive-upload-state (아카이브 클라우드 업로드 상태)', () => {
  beforeEach(() => {
    mockStorageSet.mockReset();
    mockStorageGet.mockReset();
    mockStorageRemove.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('claim: 첫 호출은 true + uploading 마커 기록', async () => {
    stubBrowserStorage();
    expect(await claimArchiveUpload('sync-A')).toBe(true);
    const setCall = mockStorageSet.mock.calls.find((c) => c[0]?.archive_upload_state);
    expect(setCall[0].archive_upload_state.syncId).toBe('sync-A');
    expect(setCall[0].archive_upload_state.status).toBe('uploading');
  });

  it('claim: 신선한 다른 syncId 마커가 있으면 false (single-flight)', async () => {
    stubBrowserStorage();
    await claimArchiveUpload('sync-A'); // Fresh marker
    expect(await claimArchiveUpload('sync-B')).toBe(false);
  });

  it('claim: 같은 syncId 재요청은 true', async () => {
    stubBrowserStorage();
    await claimArchiveUpload('sync-A');
    expect(await claimArchiveUpload('sync-A')).toBe(true);
  });

  it('claim: 만료된 다른 syncId 마커는 덮어쓴다 (true)', async () => {
    stubBrowserStorage();
    // Directly record expired marker
    await (globalThis as any).browser.storage.local.set({
      archive_upload_state: { syncId: 'sync-A', status: 'uploading', attempt: 0, at: Date.now() - STALE_MS - 1000 }
    });
    expect(await claimArchiveUpload('sync-B')).toBe(true);
    // claim only updates STATE_KEY (single marker) — verify marker syncId changed to sync-B
    const state = await (globalThis as any).browser.storage.local.get('archive_upload_state');
    expect(state.archive_upload_state.syncId).toBe('sync-B');
  });

  it('markUploaded: 상태 uploaded + 상태맵 반영 + 완료 통지', async () => {
    stubBrowserStorage();
    await claimArchiveUpload('sync-A');
    mockStorageSet.mockClear();
    await markUploaded('sync-A');
    const map = await getUploadStateMap();
    expect(map['sync-A'].status).toBe('uploaded');
    expect(mockStorageSet).toHaveBeenCalledWith({ archive_upload_last_update: expect.any(Number) });
  });

  it('markError: 상태 error + lastError 기록', async () => {
    stubBrowserStorage();
    await claimArchiveUpload('sync-A');
    await markError('sync-A', 'quota exceeded');
    const map = await getUploadStateMap();
    expect(map['sync-A'].status).toBe('error');
    expect(map['sync-A'].lastError).toBe('quota exceeded');
  });

  it('notifyArchiveUploadUpdate: 완료 통지 키에 epoch ms 기록', async () => {
    stubBrowserStorage();
    await notifyArchiveUploadUpdate();
    expect(mockStorageSet).toHaveBeenCalledWith({ archive_upload_last_update: expect.any(Number) });
  });

  it('notifyArchiveUploadError: 실패 통지 키에 syncId/error/at 기록', async () => {
    stubBrowserStorage();
    await notifyArchiveUploadError('sync-Z', 'boom');
    expect(mockStorageSet).toHaveBeenCalledWith({
      archive_upload_error: expect.objectContaining({ syncId: 'sync-Z', error: 'boom', at: expect.any(Number) })
    });
  });

  it('browser 전역 부재(노드) 시 throw 없이 no-op, get은 빈 객체', async () => {
    await expect(claimArchiveUpload('sync-A')).resolves.toBe(true);
    await expect(markUploaded('sync-A')).resolves.toBeUndefined();
    await expect(markError('sync-A', 'x')).resolves.toBeUndefined();
    expect(await getUploadStateMap()).toEqual({});
  });

  it('STALE_MS는 10분(600000ms)으로 정의된다', () => {
    expect(STALE_MS).toBe(10 * 60 * 1000);
  });
});
