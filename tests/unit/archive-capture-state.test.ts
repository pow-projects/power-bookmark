import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STALE_MS,
  setArchiveCaptureState,
  getArchiveCaptureState,
  clearArchiveCaptureState,
  notifyArchiveCaptureUpdate,
  notifyArchiveCaptureError,
  type ArchiveCaptureState
} from '../../src/lib/archive/archive-capture-state';

const {
  mockStorageSet,
  mockStorageGet,
  mockStorageRemove
} = vi.hoisted(() => ({
  mockStorageSet: vi.fn(),
  mockStorageGet: vi.fn(),
  mockStorageRemove: vi.fn()
}));

// storage.local in-memory mock — mimics actual storage.local.get/set/remove contract.
function stubBrowserStorage() {
  const store: Record<string, unknown> = {};
  mockStorageSet.mockImplementation(async (obj: Record<string, unknown>) => {
    Object.assign(store, obj);
  });
  mockStorageGet.mockImplementation(async (key: string) => {
    return { [key]: store[key] };
  });
  mockStorageRemove.mockImplementation(async (key: string) => {
    delete store[key];
  });
  vi.stubGlobal('browser', {
    storage: {
      local: {
        set: mockStorageSet,
        get: mockStorageGet,
        remove: mockStorageRemove
      }
    }
  });
}

describe('archive-capture-state (아카이브 캡처 진행 마커)', () => {
  beforeEach(() => {
    mockStorageSet.mockReset();
    mockStorageGet.mockReset();
    mockStorageRemove.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('set → get 라운드트립: 기록한 마커를 그대로 읽는다', async () => {
    stubBrowserStorage();
    const s: ArchiveCaptureState = { bookmarkId: 7, startedAt: 1234567890 };
    await setArchiveCaptureState(s);
    const got = await getArchiveCaptureState();
    expect(got).toEqual(s);
    expect(mockStorageSet).toHaveBeenCalledWith({ archive_capture_state: s });
  });

  it('clear 후 get은 undefined를 반환한다', async () => {
    stubBrowserStorage();
    await setArchiveCaptureState({ bookmarkId: 7, startedAt: 123 });
    await clearArchiveCaptureState();
    expect(await getArchiveCaptureState()).toBeUndefined();
    expect(mockStorageRemove).toHaveBeenCalledWith('archive_capture_state');
  });

  it('키가 없으면 get은 undefined를 반환한다', async () => {
    stubBrowserStorage();
    expect(await getArchiveCaptureState()).toBeUndefined();
  });

  it('claim: 신선한 다른 bookmarkId 마커가 있으면 false를 반환하고 덮어쓰지 않는다', async () => {
    stubBrowserStorage();
    // Another context currently in progress (fresh different bookmarkId)
    await setArchiveCaptureState({ bookmarkId: 99, startedAt: Date.now() });
    const claimed = await setArchiveCaptureState({ bookmarkId: 7, startedAt: Date.now() });
    expect(claimed).toBe(false);
    expect((await getArchiveCaptureState())?.bookmarkId).toBe(99); // Do not overwrite
  });

  it('claim: 같은 bookmarkId 재요청은 true를 반환하고 마커를 갱신한다', async () => {
    stubBrowserStorage();
    await setArchiveCaptureState({ bookmarkId: 7, startedAt: Date.now() });
    const claimed = await setArchiveCaptureState({ bookmarkId: 7, startedAt: Date.now() + 1000 });
    expect(claimed).toBe(true);
    expect((await getArchiveCaptureState())?.bookmarkId).toBe(7);
  });

  it('claim: 만료된 마커는 덮어쓴다 (true 반환)', async () => {
    stubBrowserStorage();
    await setArchiveCaptureState({ bookmarkId: 99, startedAt: Date.now() - STALE_MS - 1000 });
    const claimed = await setArchiveCaptureState({ bookmarkId: 7, startedAt: Date.now() });
    expect(claimed).toBe(true);
    expect((await getArchiveCaptureState())?.bookmarkId).toBe(7);
  });

  it('clear(bookmarkId): 자기 bookmarkId와 일치할 때만 제거한다 (소유권)', async () => {
    stubBrowserStorage();
    await setArchiveCaptureState({ bookmarkId: 5, startedAt: Date.now() });
    // Another page (direct write) overwrites single marker with its own — race scenario bypassing claim
    // (Since setArchiveCaptureState does not overwrite fresh different bookmarkId, reproduce via direct storage write)
    await (browser as any).storage.local.set({
      archive_capture_state: { bookmarkId: 99, startedAt: Date.now() }
    });
    // Clear 5 ownership -> 99 marker retained
    await clearArchiveCaptureState(5);
    expect((await getArchiveCaptureState())?.bookmarkId).toBe(99);
    // Clear 99 ownership -> removed
    await clearArchiveCaptureState(99);
    expect(await getArchiveCaptureState()).toBeUndefined();
  });

  it('clear() 인자 없음: 무조건 제거 (하위호환)', async () => {
    stubBrowserStorage();
    await setArchiveCaptureState({ bookmarkId: 5, startedAt: Date.now() });
    await clearArchiveCaptureState();
    expect(await getArchiveCaptureState()).toBeUndefined();
  });

  it('notifyArchiveCaptureUpdate는 성공 시 이전 실패 객체(archive_capture_error)를 제거한다', async () => {
    stubBrowserStorage();
    mockStorageRemove.mockClear();
    await notifyArchiveCaptureUpdate();
    expect(mockStorageRemove).toHaveBeenCalledWith('archive_capture_error');
  });

  it('browser 전역 부재(노드) 시 throw 없이 no-op, get은 undefined', async () => {
    // browser unset state — hasStorage() is false -> all calls skipped silently
    await expect(setArchiveCaptureState({ bookmarkId: 1, startedAt: Date.now() })).resolves.toBe(true);
    await expect(clearArchiveCaptureState()).resolves.toBeUndefined();
    await expect(notifyArchiveCaptureUpdate()).resolves.toBeUndefined();
    await expect(notifyArchiveCaptureError(1, 'boom')).resolves.toBeUndefined();
    expect(await getArchiveCaptureState()).toBeUndefined();
  });

  it('notifyArchiveCaptureUpdate는 완료 통지 키에 epoch ms를 기록한다', async () => {
    stubBrowserStorage();
    await notifyArchiveCaptureUpdate();
    expect(mockStorageSet).toHaveBeenCalledWith({ archive_capture_last_update: expect.any(Number) });
    const { archive_capture_last_update } = mockStorageSet.mock.calls[0][0];
    expect(archive_capture_last_update).toBeGreaterThan(0);
  });

  it('notifyArchiveCaptureError는 실패 통지 키에 bookmarkId/error/at를 기록한다', async () => {
    stubBrowserStorage();
    await notifyArchiveCaptureError(42, 'fetch failed');
    expect(mockStorageSet).toHaveBeenCalledWith({
      archive_capture_error: expect.objectContaining({ bookmarkId: 42, error: 'fetch failed', at: expect.any(Number) })
    });
  });

  it('STALE_MS는 10분(600000ms)으로 정의된다', () => {
    expect(STALE_MS).toBe(10 * 60 * 1000);
  });
});
