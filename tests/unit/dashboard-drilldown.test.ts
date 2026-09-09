import { describe, it, expect } from 'vitest';
import {
  buildDrilldownUrl,
  parseDrilldownParams,
  UNCATEGORIZED_SENTINEL
} from '../../src/lib/stats/dashboard-drilldown';

const BASE = '/management.html';

describe('buildDrilldownUrl', () => {
  it('host: 유효한 host → 북마크 관리 검색 딥링크(host 쿼리) 생성', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'host', host: 'github.com' });
    expect(url).toBe(`${BASE}?tab=bookmarks&host=github.com`);
  });

  it('host: 특수문자 포함 host를 URL 인코딩', () => {
    const host = 'foo.bar/sub#x&y';
    const url = buildDrilldownUrl(BASE, { kind: 'host', host });
    expect(url).toBe(`${BASE}?tab=bookmarks&host=${encodeURIComponent(host)}`);
  });

  it('host: 빈 문자열 → null (내비게이션 금지, no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'host', host: '' })).toBeNull();
  });

  it('host: 공백만 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'host', host: '   ' })).toBeNull();
  });

  it('folder: 유효한 folderPath(원본 문자열 유지, re-normalize 금지) → folder 쿼리', () => {
    const folderPath = 'Bookmarks Bar/개발/실전 프로젝트';
    const url = buildDrilldownUrl(BASE, { kind: 'folder', folder: folderPath });
    expect(url).toBe(`${BASE}?tab=bookmarks&folder=${encodeURIComponent(folderPath)}`);
  });

  it(`folder: UNCATEGORIZED_SENTINEL('기타') → filter=uncategorized 로 치환`, () => {
    const url = buildDrilldownUrl(BASE, { kind: 'folder', folder: UNCATEGORIZED_SENTINEL });
    expect(url).toBe(`${BASE}?tab=bookmarks&filter=uncategorized`);
    expect(url).not.toContain('folder=기타');
  });

  it('folder: 빈 문자열 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'folder', folder: '' })).toBeNull();
  });

  it('folder: 공백만 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'folder', folder: '   ' })).toBeNull();
  });

  it('tag: 유효한 tag → tag 쿼리 생성', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'tag', tag: 'typescript' });
    expect(url).toBe(`${BASE}?tab=bookmarks&tag=typescript`);
  });

  it('tag: 앞의 # 접두사 제거', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'tag', tag: '#frontend' });
    expect(url).toBe(`${BASE}?tab=bookmarks&tag=frontend`);
  });

  it('tag: 특수문자 포함 tag URL 인코딩', () => {
    const tag = 'c++ & c#';
    const url = buildDrilldownUrl(BASE, { kind: 'tag', tag });
    expect(url).toBe(`${BASE}?tab=bookmarks&tag=${encodeURIComponent('c++ & c#')}`);
  });

  it('tag: 빈 문자열 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'tag', tag: '' })).toBeNull();
  });

  it('tag: 공백만 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'tag', tag: '   ' })).toBeNull();
  });

  it('tag: #만 있거나 # 뒤에 공백만 → null (no-op)', () => {
    expect(buildDrilldownUrl(BASE, { kind: 'tag', tag: '#' })).toBeNull();
    expect(buildDrilldownUrl(BASE, { kind: 'tag', tag: '#   ' })).toBeNull();
  });

  it('기타: 잘못된 kind 값에 대해서도 crash 하지 않음 (null 반환 or folder 경로)', () => {
    // Zero-defect policy for missing kind/folder: empty field -> null (outlier-safe)
    expect(buildDrilldownUrl(BASE, { kind: 'host', host: undefined as any })).toBeNull();
    expect(buildDrilldownUrl(BASE, { kind: 'folder', folder: null as any })).toBeNull();
    expect(buildDrilldownUrl(BASE, { kind: 'tag', tag: null as any })).toBeNull();
  });
});

describe('parseDrilldownParams', () => {
  it('쿼리 없음 → 빈 객체', () => {
    expect(parseDrilldownParams('')).toEqual({});
    expect(parseDrilldownParams('?foo=bar')).toEqual({});
  });

  it('?host= → { host } (검색 쿼리 소비)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&host=github.com')).toEqual({
      host: 'github.com'
    });
  });

  it('?folder= → { folder } (폴더 선택 소비, URI 디코딩)', () => {
    const folderPath = 'Bookmarks Bar/개발/실전 프로젝트';
    const search = `?tab=bookmarks&folder=${encodeURIComponent(folderPath)}`;
    expect(parseDrilldownParams(search)).toEqual({ folder: folderPath });
  });

  it('?filter=uncategorized → { filterUncategorized: true }', () => {
    expect(parseDrilldownParams('?tab=bookmarks&filter=uncategorized')).toEqual({
      filterUncategorized: true
    });
  });

  it('?filter= 그 외 값 → filterUncategorized 미설정(무시)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&filter=broken')).toEqual({});
  });

  it('?tag= → { tag }', () => {
    expect(parseDrilldownParams('?tab=bookmarks&tag=typescript')).toEqual({
      tag: 'typescript'
    });
  });

  it('?tag= 앞의 # 접두사 제거', () => {
    expect(parseDrilldownParams('?tab=bookmarks&tag=%23react')).toEqual({
      tag: 'react'
    });
  });

  it('상호 배타적 우선순위: host > filter > folder > tag (host 최우선)', () => {
    const dp = parseDrilldownParams('?tab=bookmarks&host=github.com&filter=uncategorized&folder=Some/Folder&tag=dev');
    expect(dp).toEqual({ host: 'github.com' });
  });

  it('상호 배타적 우선순위: host > filter (host 우선)', () => {
    expect(
      parseDrilldownParams('?tab=bookmarks&host=github.com&filter=uncategorized')
    ).toEqual({ host: 'github.com' });
  });

  it('상호 배타적 우선순위: host > folder (host 우선)', () => {
    const dp = parseDrilldownParams('?tab=bookmarks&host=github.com&folder=Some/Folder');
    expect(dp).toEqual({ host: 'github.com' });
  });

  it('상호 배타적 우선순위: host > tag (host 우선)', () => {
    expect(
      parseDrilldownParams('?tab=bookmarks&host=github.com&tag=dev')
    ).toEqual({ host: 'github.com' });
  });

  it('상호 배타적 우선순위: filter > folder (filter 우선)', () => {
    expect(
      parseDrilldownParams(`?tab=bookmarks&folder=${encodeURIComponent('A/B')}&filter=uncategorized`)
    ).toEqual({ filterUncategorized: true });
  });

  it('상호 배타적 우선순위: filter > tag (filter 우선)', () => {
    expect(
      parseDrilldownParams('?tab=bookmarks&filter=uncategorized&tag=dev')
    ).toEqual({ filterUncategorized: true });
  });

  it('상호 배타적 우선순위: folder > tag (folder 우선)', () => {
    expect(
      parseDrilldownParams('?tab=bookmarks&folder=Dev&tag=react')
    ).toEqual({ folder: 'Dev' });
  });

  it('host가 공백만 → 무시(설정 안 함, crash 없음)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&host=%20%20%20')).toEqual({});
  });

  it('folder가 공백만 → 무시(설정 안 함, crash 없음)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&folder=%20')).toEqual({});
  });

  it('tag가 공백만 → 무시(설정 안 함, crash 없음)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&tag=%20%20')).toEqual({});
  });

  it('tag가 #만 → 무시(설정 안 함, crash 없음)', () => {
    expect(parseDrilldownParams('?tab=bookmarks&tag=%23')).toEqual({});
  });

  it('버그 재현: ?host=abc&host=def 중복 키 → 첫 번째 값 사용', () => {
    expect(parseDrilldownParams('?tab=bookmarks&host=abc&host=def')).toEqual({
      host: 'abc'
    });
  });

  it('round-trip: build(host) → parse → host 복원', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'host', host: 'github.com' });
    const search = url!.split('?')[1];
    expect(parseDrilldownParams(`?${search}`)).toEqual({ host: 'github.com' });
  });

  it('round-trip: build(folder) → parse → folder 원본 복원', () => {
    const folderPath = 'Bookmarks Bar/개발/실전 프로젝트';
    const url = buildDrilldownUrl(BASE, { kind: 'folder', folder: folderPath });
    const search = url!.split('?')[1];
    expect(parseDrilldownParams(`?${search}`)).toEqual({ folder: folderPath });
  });

  it('round-trip: build(기타) → parse → filterUncategorized 복원', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'folder', folder: UNCATEGORIZED_SENTINEL });
    const search = url!.split('?')[1];
    expect(parseDrilldownParams(`?${search}`)).toEqual({ filterUncategorized: true });
  });

  it('round-trip: build(tag) → parse → tag 복원', () => {
    const url = buildDrilldownUrl(BASE, { kind: 'tag', tag: '#svelte' });
    const search = url!.split('?')[1];
    expect(parseDrilldownParams(`?${search}`)).toEqual({ tag: 'svelte' });
  });
});