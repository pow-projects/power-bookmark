import { describe, it, expect } from 'vitest';
import {
  resolveBookmarkWinner,
  sameTags,
  dedupeByUrl,
  isConcurrentWrite,
  findUrlIdConflicts,
  isEmptyBookmark,
  isFillGapPair,
  generateDeterministicSyncId,
  contentDiffers
} from '../../src/lib/sync/merge';
import type { Bookmark } from '../../src/lib/db';

function makeBookmark(id: string, modifiedAt: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 1,
    bookmarkId: id,
    syncId: id,
    url: 'https://example.com',
    title: 'Example',
    description: 'desc',
    folderPath: '',
    createdAt: modifiedAt,
    modifiedAt,
    visitCount: 0,
    ...overrides
  };
}

describe('resolveBookmarkWinner', () => {
  it('local.modifiedAt > cloud → local 승', () => {
    const local = makeBookmark('bk-1', 200);
    const cloud = makeBookmark('bk-1', 100);
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.winner).toBe(local);
    expect(result.loser).toBe(cloud);
  });

  it('local.modifiedAt < cloud → cloud 승', () => {
    const local = makeBookmark('bk-1', 100);
    const cloud = makeBookmark('bk-1', 200);
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.winner).toBe(cloud);
    expect(result.loser).toBe(local);
  });

  it('동점(===) → cloud 승 (winner·loser assert)', () => {
    const local = makeBookmark('bk-1', 100);
    const cloud = makeBookmark('bk-1', 100);
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.winner).toBe(cloud);
    expect(result.loser).toBe(local);
  });

  it('modifiedAt 다르고 내용도 다르면 → isConflict false (단방향 수정은 충돌 아님)', () => {
    const local = makeBookmark('bk-1', 200, { description: 'local edit' });
    const cloud = makeBookmark('bk-1', 100, { description: 'cloud old' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('modifiedAt 다르고 태그도 다르면 → isConflict false (순차 수정은 충돌 아님)', () => {
    const local = makeBookmark('bk-1', 200, { tags: ['a'] });
    const cloud = makeBookmark('bk-1', 100, { tags: ['b'] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('동점 + 태그만 다름 → isConflict true, winner cloud', () => {
    const local = makeBookmark('bk-1', 100, { tags: ['a'] });
    const cloud = makeBookmark('bk-1', 100, { tags: ['b'] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(true);
    expect(result.winner).toBe(cloud);
  });

  it('동점 + folderPath만 다름 → isConflict true, winner cloud', () => {
    const local = makeBookmark('bk-1', 100, { folderPath: '개발/React' });
    const cloud = makeBookmark('bk-1', 100, { folderPath: '개발/Svelte' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(true);
    expect(result.winner).toBe(cloud);
  });

  it('modifiedAt 다르고 folderPath도 다르면 → isConflict false (정상 LWW)', () => {
    const local = makeBookmark('bk-1', 200, { folderPath: '개발/React' });
    const cloud = makeBookmark('bk-1', 100, { folderPath: '개발/Svelte' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('태그 순서만 다른 동점 → isConflict false (정렬 비교)', () => {
    const local = makeBookmark('bk-1', 100, { tags: ['a', 'b'] });
    const cloud = makeBookmark('bk-1', 100, { tags: ['b', 'a'] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
  });

  it('tags undefined vs 빈 배열 → isConflict false', () => {
    const local = makeBookmark('bk-1', 100, { tags: undefined });
    const cloud = makeBookmark('bk-1', 100, { tags: [] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
  });

  it('firstSync: URL 동일 + folderPath 다름 + modifiedAt 다름 → isConflict true (modifiedAt 무시)', () => {
    const local = makeBookmark('bk-1', 200, { folderPath: '개발/React' });
    const cloud = makeBookmark('bk-1', 100, { folderPath: '개발/Svelte' });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(true);
    expect(result.winner).toBe(local);
  });

  it('firstSync: URL 동일 + 설명 다름 + modifiedAt 다름 → isConflict true (modifiedAt 무시)', () => {
    const local = makeBookmark('bk-1', 200, { description: 'local edit' });
    const cloud = makeBookmark('bk-1', 100, { description: 'cloud old' });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(true);
    // Winner preserves the one with larger modifiedAt regardless of isFirstSync
    expect(result.winner).toBe(local);
  });

  it('firstSync: URL 동일 + 설명 동일 → isConflict false', () => {
    const local = makeBookmark('bk-1', 200, { description: 'same' });
    const cloud = makeBookmark('bk-1', 100, { description: 'same' });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('firstSync: URL 다름 + 내용 다름 → isConflict false (URL이 같아야 충돌)', () => {
    const local = makeBookmark('bk-1', 200, { url: 'https://a.com', description: 'A' });
    const cloud = makeBookmark('bk-1', 100, { url: 'https://b.com', description: 'B' });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('firstSync: URL 동일 + modifiedAt 동점 + 내용 동일 → isConflict false', () => {
    const local = makeBookmark('bk-1', 100);
    const cloud = makeBookmark('bk-1', 100);
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(cloud); // Tie goes to cloud (preserve LWW)
  });

  it('firstSync 미지정(undefined) → 기존 동작 유지: modifiedAt 다르면 isConflict false', () => {
    const local = makeBookmark('bk-1', 200, { description: 'local edit' });
    const cloud = makeBookmark('bk-1', 100, { description: 'cloud old' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('firstSync 미지정(undefined) → 기존 동작 유지: modifiedAt 동점 + 내용 다름이면 isConflict true', () => {
    const local = makeBookmark('bk-1', 100, { description: 'local edit' });
    const cloud = makeBookmark('bk-1', 100, { description: 'cloud old' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(true);
    expect(result.winner).toBe(cloud); // Tie goes to cloud
  });

  // === Filled vs Empty gap (same URL/title + one side has empty content/folder classification) ===
  it('fill-gap: 로컬이 내용·폴더분류 전부 빈, 클라우드가 채워짐 → cloud 승, 충돌 아님 (modifiedAt 무시)', () => {
    const local = makeBookmark('bk-1', 500, { description: '', folderPath: '', tags: [] });
    const cloud = makeBookmark('bk-1', 100, { description: '채워진 설명', folderPath: '커뮤니티/개발' });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(cloud); // Filled side wins — even if modifiedAt is smaller
    expect(result.loser).toBe(local);
  });

  it('fill-gap: 클라우드가 빈, 로컬이 채워짐 → local 승, 충돌 아님 (modifiedAt 무시)', () => {
    const local = makeBookmark('bk-1', 100, { description: '채워진 설명', folderPath: '커뮤니티', tags: ['a'] });
    const cloud = makeBookmark('bk-1', 500, { description: '', folderPath: '', tags: [] });
    const result = resolveBookmarkWinner(local, cloud, { firstSync: true });
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local); // Filled side wins — even if modifiedAt is smaller
    expect(result.loser).toBe(cloud);
  });

  it('fill-gap: firstSync 미지정(일반 sync)에서도 modifiedAt 무시하고 채워진 쪽 승', () => {
    const local = makeBookmark('bk-1', 100, { description: '채워진 설명', folderPath: '커뮤니티' });
    const cloud = makeBookmark('bk-1', 999, { description: '', folderPath: '', tags: [] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(local);
  });

  it('fill-gap: URL이 다르면 갭이 아님 (기존 로직 유지)', () => {
    const local = makeBookmark('bk-1', 500, { url: 'https://a.com', description: '', folderPath: '', tags: [] });
    const cloud = makeBookmark('bk-1', 100, { url: 'https://b.com', description: 'x', folderPath: 'f' });
    const result = resolveBookmarkWinner(local, cloud);
    // Different URLs follow normal LWW — local modifiedAt is larger -> local wins, not a conflict (different URLs in firstSync also not a conflict)
    expect(result.winner).toBe(local);
    expect(result.isConflict).toBe(false);
  });

  it('fill-gap: 제목이 다르면 갭이 아님 (기존 로직 유지)', () => {
    const local = makeBookmark('bk-1', 500, { title: 'A', description: '', folderPath: '', tags: [] });
    const cloud = makeBookmark('bk-1', 100, { title: 'B', description: 'x', folderPath: 'f' });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.winner).toBe(local); // Larger modifiedAt
    expect(result.isConflict).toBe(false);
  });

  it('fill-gap: 양쪽 모두 빈이면 갭 아님 (LWW 유지 — 채워진 쪽이 없으므로)', () => {
    const local = makeBookmark('bk-1', 100, { description: '', folderPath: '', tags: [] });
    const cloud = makeBookmark('bk-1', 500, { description: '', folderPath: '', tags: [] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.winner).toBe(cloud); // Side with larger modifiedAt
    expect(result.isConflict).toBe(false);
  });

  it('aiCategory만 다르던 쌍은 aiCategory 제거로 내용이 동일해져 isConflict false', () => {
    // aiCategory field was removed from Bookmark type — two bookmarks that previously differed only by aiCategory
    // actually have identical title/url/description/tags. Must not be caught as conflict even if tied.
    const local = makeBookmark('bk-1', 100, { tags: ['dev'] });
    const cloud = makeBookmark('bk-1', 100, { tags: ['dev'] });
    const result = resolveBookmarkWinner(local, cloud);
    expect(result.isConflict).toBe(false);
    expect(result.winner).toBe(cloud); // Tie goes to cloud
  });
});

describe('sameTags', () => {
  it('정렬 후 동일하면 true', () => {
    expect(sameTags(['x', 'y'], ['y', 'x'])).toBe(true);
  });

  it('undefined와 빈 배열은 동일 취급', () => {
    expect(sameTags(undefined, [])).toBe(true);
    expect(sameTags(undefined, undefined)).toBe(true);
  });
});

describe('dedupeByUrl', () => {
  it('URL 중복이 없으면 전부 keep, duplicates 비어있음', () => {
    const a = makeBookmark('bk-1', 100, { url: 'https://a.com' });
    const b = makeBookmark('bk-2', 200, { url: 'https://b.com' });
    const { keep, duplicates } = dedupeByUrl([a, b]);
    expect(keep).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('같은 URL이 여러 bookmarkId로 존재하면 modifiedAt 최신만 keep', () => {
    const old1 = makeBookmark('bk-1', 100, { url: 'https://car.com' });
    const old2 = makeBookmark('bk-2', 100, { url: 'https://car.com' });
    const newest = makeBookmark('bk-3', 300, { url: 'https://car.com' });
    const { keep, duplicates } = dedupeByUrl([old1, old2, newest]);
    expect(keep).toHaveLength(1);
    expect(keep[0].bookmarkId).toBe('bk-3');
    expect(duplicates.map(d => d.bookmarkId).sort()).toEqual(['bk-1', 'bk-2']);
  });

  it('동일 modifiedAt 동점이면 먼저 온 항목이 승자(결정적)', () => {
    const a = makeBookmark('bk-1', 100, { url: 'https://car.com' });
    const b = makeBookmark('bk-2', 100, { url: 'https://car.com' });
    const { keep, duplicates } = dedupeByUrl([a, b]);
    expect(keep[0].bookmarkId).toBe('bk-1');
    expect(duplicates[0].bookmarkId).toBe('bk-2');
  });

  it('서로 다른 URL의 동일 title은 중복 아님', () => {
    const a = makeBookmark('bk-1', 100, { url: 'https://a.com', title: 'T' });
    const b = makeBookmark('bk-2', 200, { url: 'https://b.com', title: 'T' });
    const { keep, duplicates } = dedupeByUrl([a, b]);
    expect(keep).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });
});


describe('findUrlIdConflicts', () => {
  it('같은 URL·다른 bookmarkId + 내용 다르면 충돌로 반환한다', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'local edit' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://car.com', title: 'Car', description: 'cloud old' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(1);
    expect(result[0].local.bookmarkId).toBe('bk-X');
    expect(result[0].cloud.bookmarkId).toBe('bk-Y');
  });

  it('같은 URL·다른 bookmarkId + folderPath만 다르면 충돌로 반환한다', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'same', folderPath: '폴더A' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://car.com', title: 'Car', description: 'same', folderPath: '폴더B' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(1);
    expect(result[0].local.bookmarkId).toBe('bk-X');
    expect(result[0].cloud.bookmarkId).toBe('bk-Y');
  });

  it('같은 URL·다른 bookmarkId지만 내용이 동일하면 충돌이 아니다 (순수 중복 → dedupe로 정리)', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'same' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://car.com', title: 'Car', description: 'same' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(0);
  });

  it('내용 동일 기준에 태그 순서는 무시한다 (정렬 비교 → 동일 취급)', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'same', tags: ['a', 'b'] });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://car.com', title: 'Car', description: 'same', tags: ['b', 'a'] });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(0);
  });

  it('같은 URL이라도 bookmarkId가 같으면 충돌 아님 (정상 매칭)', () => {
    const local = makeBookmark('bk-1', 200, { url: 'https://car.com' });
    const cloud = makeBookmark('bk-1', 100, { url: 'https://car.com' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(0);
  });

  it('syncId가 충돌 판정 키다: 같은 bookmarkId라도 syncId가 다르고 내용이 다르면 충돌', () => {
    // Even if browser local id (bookmarkId) is identical, if global sync keys (syncId) differ,
    // they are considered separate bookmarks -> caught as URL duplicate conflict if contents differ.
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'local edit', syncId: 'sync-A' });
    const cloud = makeBookmark('bk-X', 100, { url: 'https://car.com', title: 'Car', description: 'cloud old', syncId: 'sync-B' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(1);
    expect(result[0].local.syncId).toBe('sync-A');
    expect(result[0].cloud.syncId).toBe('sync-B');
  });

  it('syncId가 같고 내용이 같으면 충돌 아님 (bookmarkId가 달라도 동일 항목)', () => {
    // If global syncId is identical, they are the same bookmark -> not a conflict even if bookmarkId differs.
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'same', syncId: 'sync-Z' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://car.com', title: 'Car', description: 'same', syncId: 'sync-Z' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(0);
  });

  it('URL이 다르면 bookmarkId가 달라도 충돌 아님', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://a.com' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://b.com' });
    const result = findUrlIdConflicts([local], [cloud]);
    expect(result).toHaveLength(0);
  });

  it('같은 URL의 클라우드 항목이 여러 개면 첫 번째만 사용(결정적)', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com', title: 'Car', description: 'local' });
    const cloudA = makeBookmark('bk-Y', 300, { url: 'https://car.com', title: 'Car', description: 'A' });
    const cloudB = makeBookmark('bk-Z', 400, { url: 'https://car.com', title: 'Car', description: 'B' });
    const result = findUrlIdConflicts([local], [cloudA, cloudB]);
    expect(result).toHaveLength(1);
    expect(result[0].cloud.bookmarkId).toBe('bk-Y');
  });

  it('빈 입력이면 빈 결과', () => {
    expect(findUrlIdConflicts([], [])).toEqual([]);
    const b = makeBookmark('bk-1', 100);
    expect(findUrlIdConflicts([b], [])).toEqual([]);
    expect(findUrlIdConflicts([], [b])).toHaveLength(0);
  });

  it('로컬 항목이 하나만 있어도 같은 URL의 다른 ID 클라우드가 없으면 충돌 아님', () => {
    const local = makeBookmark('bk-X', 200, { url: 'https://car.com' });
    const cloud = makeBookmark('bk-Y', 100, { url: 'https://train.com' });
    expect(findUrlIdConflicts([local], [cloud])).toHaveLength(0);
  });
});

describe('isEmptyBookmark / isFillGapPair', () => {
  it('모든 내용·폴더분류 필드가 비면 isEmptyBookmark true', () => {
    const b = makeBookmark('bk-1', 100, { description: '', folderPath: '', tags: [] });
    expect(isEmptyBookmark(b)).toBe(true);
  });

  it('tags undefined도 빈으로 취급', () => {
    const b = makeBookmark('bk-1', 100, { description: '', folderPath: '', tags: undefined });
    expect(isEmptyBookmark(b)).toBe(true);
  });

  it('설명만 있어도 isEmptyBookmark false (채워짐)', () => {
    const b = makeBookmark('bk-1', 100, { description: 'x' });
    expect(isEmptyBookmark(b)).toBe(false);
  });

  it('폴더분류만 있어도 isEmptyBookmark false (채워짐)', () => {
    const b = makeBookmark('bk-1', 100, { description: '', folderPath: '커뮤니티' });
    expect(isEmptyBookmark(b)).toBe(false);
  });

  it('한쪽만 빈 + URL·제목 동일 → isFillGapPair true', () => {
    const a = makeBookmark('bk-1', 100, { description: '', folderPath: '', tags: [] });
    const b = makeBookmark('bk-1', 100, { description: 'x', folderPath: 'f' });
    expect(isFillGapPair(a, b)).toBe(true);
    expect(isFillGapPair(b, a)).toBe(true);
  });

  it('양쪽 모두 채워짐이면 isFillGapPair false', () => {
    const a = makeBookmark('bk-1', 100, { description: 'x' });
    const b = makeBookmark('bk-1', 100, { description: 'y' });
    expect(isFillGapPair(a, b)).toBe(false);
  });

  it('양쪽 모두 빈이면 isFillGapPair false', () => {
    const a = makeBookmark('bk-1', 100, { description: '', folderPath: '' });
    const b = makeBookmark('bk-1', 100, { description: '', folderPath: '' });
    expect(isFillGapPair(a, b)).toBe(false);
  });

  it('URL이 다르면 isFillGapPair false', () => {
    const a = makeBookmark('bk-1', 100, { url: 'https://a.com', description: '', folderPath: '' });
    const b = makeBookmark('bk-1', 100, { url: 'https://b.com', description: 'x' });
    expect(isFillGapPair(a, b)).toBe(false);
  });

  it('루트 폴더 경로(Bookmarks bar, Other bookmarks 등)도 빈 폴더로 취급하여 isEmptyBookmark true', () => {
    const b1 = makeBookmark('bk-1', 100, { description: '', folderPath: 'Bookmarks bar', tags: [] });
    const b2 = makeBookmark('bk-2', 100, { description: '', folderPath: 'Other bookmarks', tags: [] });
    const b3 = makeBookmark('bk-3', 100, { description: '', folderPath: '북마크바', tags: [] });
    expect(isEmptyBookmark(b1)).toBe(true);
    expect(isEmptyBookmark(b2)).toBe(true);
    expect(isEmptyBookmark(b3)).toBe(true);
  });
});

describe('isConcurrentWrite', () => {
  it('base === current → false (동시 write 아님, write 진행 안전)', () => {
    expect(isConcurrentWrite(100, 100)).toBe(false);
  });

  it('base < current → true (다른 기기가 수정함)', () => {
    expect(isConcurrentWrite(100, 200)).toBe(true);
  });

  it('base > current → true (다른 기기가 수정함)', () => {
    expect(isConcurrentWrite(200, 100)).toBe(true);
  });

  it('base 0 / current > 0 → true (신규 파일 캡처 실패 후 재검증 성공)', () => {
    expect(isConcurrentWrite(0, 100)).toBe(true);
  });

  it('base 0 / current -1 → true (재검증 실패 폴백 — 순수 함수 계약은 동일)', () => {
    expect(isConcurrentWrite(0, -1)).toBe(true);
  });
});

describe('generateDeterministicSyncId', () => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('유효한 UUID v5 형식의 문자열을 반환한다', () => {
    const id = generateDeterministicSyncId('https://example.com');
    expect(id).toMatch(uuidRegex);
  });

  it('동일한 URL에 대해 여러 번 호출해도 항상 동일한 UUID를 생성한다 (결정적)', () => {
    const id1 = generateDeterministicSyncId('https://github.com/facebook/react');
    const id2 = generateDeterministicSyncId('https://github.com/facebook/react');
    const id3 = generateDeterministicSyncId('https://github.com/facebook/react');
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it('trailing slash 유무와 무관하게 동일한 UUID를 생성한다 (URL 정규화 연동)', () => {
    const withSlash = generateDeterministicSyncId('https://example.com/path/');
    const withoutSlash = generateDeterministicSyncId('https://example.com/path');
    expect(withSlash).toBe(withoutSlash);
  });

  it('쿼리 파라미터 순서가 달라도 동일한 UUID를 생성한다', () => {
    const url1 = generateDeterministicSyncId('https://example.com/search?q=test&lang=ko');
    const url2 = generateDeterministicSyncId('https://example.com/search?lang=ko&q=test');
    expect(url1).toBe(url2);
  });

  it('서로 다른 URL은 서로 다른 UUID를 생성한다', () => {
    const idA = generateDeterministicSyncId('https://google.com');
    const idB = generateDeterministicSyncId('https://naver.com');
    expect(idA).not.toBe(idB);
  });

  it('빈 문자열이나 공백도 에러 없이 유효한 UUID를 반환한다', () => {
    const empty = generateDeterministicSyncId('');
    expect(empty).toMatch(uuidRegex);
  });
});

describe('contentDiffers', () => {
  it('모든 주요 필드가 동일하면 false', () => {
    const a = makeBookmark('bk-1', 100, { title: 'T', url: 'https://example.com', description: 'D', folderPath: 'F', tags: ['a', 'b'] });
    const b = makeBookmark('bk-2', 200, { title: 'T', url: 'https://example.com', description: 'D', folderPath: 'F', tags: ['b', 'a'] });
    expect(contentDiffers(a, b)).toBe(false);
  });

  it('trailing slash만 다른 URL은 동일한 내용으로 판정 (false)', () => {
    const a = makeBookmark('bk-1', 100, { url: 'https://example.com/' });
    const b = makeBookmark('bk-2', 200, { url: 'https://example.com' });
    expect(contentDiffers(a, b)).toBe(false);
  });

  it('title이 다르면 true', () => {
    const a = makeBookmark('bk-1', 100, { title: 'T1' });
    const b = makeBookmark('bk-2', 100, { title: 'T2' });
    expect(contentDiffers(a, b)).toBe(true);
  });

  it('description이 다르면 true', () => {
    const a = makeBookmark('bk-1', 100, { description: 'D1' });
    const b = makeBookmark('bk-2', 100, { description: 'D2' });
    expect(contentDiffers(a, b)).toBe(true);
  });

  it('folderPath가 다르면 true', () => {
    const a = makeBookmark('bk-1', 100, { folderPath: 'F1' });
    const b = makeBookmark('bk-2', 100, { folderPath: 'F2' });
    expect(contentDiffers(a, b)).toBe(true);
  });

  it('folderPath가 시스템 루트 접두 유무만 다른 동일 위치면 false (정규화 비교)', () => {
    const a = makeBookmark('bk-1', 100, { folderPath: 'Bookmarks Bar/개발' });
    const b = makeBookmark('bk-2', 100, { folderPath: '개발' });
    expect(contentDiffers(a, b)).toBe(false);
  });

  it('folderPath가 다른 루트(Bookmarks Bar vs Other bookmarks)에 속하면 true', () => {
    const a = makeBookmark('bk-1', 100, { folderPath: 'Bookmarks Bar/개발' });
    const b = makeBookmark('bk-2', 100, { folderPath: 'Other bookmarks/개발' });
    expect(contentDiffers(a, b)).toBe(true);
  });

  it('tags가 다르면 true', () => {
    const a = makeBookmark('bk-1', 100, { tags: ['a'] });
    const b = makeBookmark('bk-2', 100, { tags: ['b'] });
    expect(contentDiffers(a, b)).toBe(true);
  });

  it('description이 빈 문자열("")과 undefined일 때 false (허위 충돌 방지)', () => {
    const a = makeBookmark('bk-1', 100, { description: '' });
    const b = makeBookmark('bk-2', 100, { description: undefined });
    expect(contentDiffers(a, b)).toBe(false);
  });

  it('title 공백 차이만 있을 때 false (트림 비교)', () => {
    const a = makeBookmark('bk-1', 100, { title: 'Test Bookmark ' });
    const b = makeBookmark('bk-2', 100, { title: 'Test Bookmark' });
    expect(contentDiffers(a, b)).toBe(false);
  });
});
