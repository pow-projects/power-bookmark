import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ROOT_NAMES,
  isSystemRootTitle,
  getRootFolderName,
  normalizeFolderPath,
  isSameFolderLocation,
  isUncategorizedBookmark,
  getLeafFolderName,
  sanitizeTechnicalSlashes,
  clampNewFolderDepth,
  levenshteinDistance,
  findFuzzyMatchingFolder,
  KNOWN_FOLDER_TYPOS,
  GENERIC_LEAF_NAMES
} from '../../src/lib/bookmarks/folder-utils';

describe('folder-utils', () => {
  describe('isSystemRootTitle', () => {
    it('브라우저 시스템 루트 폴더명을 정확히 인식한다 (대소문자/공백 무시)', () => {
      expect(isSystemRootTitle('Bookmarks Bar')).toBe(true);
      expect(isSystemRootTitle('bookmarks bar')).toBe(true);
      expect(isSystemRootTitle(' Other bookmarks ')).toBe(true);
      expect(isSystemRootTitle('모바일 북마크')).toBe(true);
      expect(isSystemRootTitle('북마크바')).toBe(true);
      expect(isSystemRootTitle('개발')).toBe(false);
      expect(isSystemRootTitle('')).toBe(false);
      expect(isSystemRootTitle(undefined)).toBe(false);
    });
  });

  describe('getRootFolderName', () => {
    it('경로의 첫 세그먼트가 루트명이면 해당 루트명을 반환한다', () => {
      expect(getRootFolderName('Other bookmarks/개발')).toBe('Other bookmarks');
      expect(getRootFolderName('Bookmarks bar/Tech')).toBe('Bookmarks bar');
      expect(getRootFolderName('기타 북마크/뉴스')).toBe('기타 북마크');
    });

    it('루트명이 없거나 빈 경로면 기본값 Bookmarks bar를 반환한다', () => {
      expect(getRootFolderName('개발/프론트')).toBe('Bookmarks bar');
      expect(getRootFolderName('')).toBe('Bookmarks bar');
      expect(getRootFolderName(undefined)).toBe('Bookmarks bar');
    });

    it('folders 트리가 제공되면 트리의 루트 정보를 우선 매칭한다', () => {
      const folders = [
        { id: '1', title: 'Bookmarks bar', path: 'Bookmarks bar' },
        { id: '2', title: 'Other bookmarks', path: 'Other bookmarks' }
      ];
      expect(getRootFolderName('Other bookmarks/개발', folders)).toBe('Other bookmarks');
      expect(getRootFolderName('', folders)).toBe('Bookmarks bar');
    });
  });

  describe('normalizeFolderPath', () => {
    it('시스템 루트 폴더명을 경로에서 제거한다', () => {
      expect(normalizeFolderPath('Bookmarks Bar/커뮤니티')).toBe('커뮤니티');
      expect(normalizeFolderPath('Other bookmarks/개발/프론트')).toBe('개발/프론트');
      expect(normalizeFolderPath('Bookmarks bar')).toBe('');
      expect(normalizeFolderPath('Other bookmarks')).toBe('');
      expect(normalizeFolderPath('')).toBe('');
      expect(normalizeFolderPath(undefined)).toBe('');
    });
  });

  describe('isSameFolderLocation', () => {
    it('동일 루트 및 동일 하위 경로면 true', () => {
      expect(isSameFolderLocation('Bookmarks bar/개발', 'Bookmarks bar/개발')).toBe(true);
      expect(isSameFolderLocation('Other bookmarks/개발', 'Other bookmarks/개발')).toBe(true);
    });

    it('기본 루트(Bookmarks bar) 접두 유무 차이는 동일 위치(true)로 판정', () => {
      expect(isSameFolderLocation('Bookmarks bar/개발', '개발')).toBe(true);
      expect(isSameFolderLocation('개발', 'Bookmarks bar/개발')).toBe(true);
    });

    it('다른 루트에 위치하면 false', () => {
      expect(isSameFolderLocation('Bookmarks bar/개발', 'Other bookmarks/개발')).toBe(false);
      expect(isSameFolderLocation('개발', 'Other bookmarks/개발')).toBe(false);
    });

    it('하위 경로가 다르면 false', () => {
      expect(isSameFolderLocation('Bookmarks bar/개발', 'Bookmarks bar/디자인')).toBe(false);
    });
  });

  describe('isUncategorizedBookmark', () => {
    it('시스템 루트 직속이나 빈 경로면 true', () => {
      expect(isUncategorizedBookmark({ folderPath: '' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: 'Bookmarks bar' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: 'Other bookmarks' })).toBe(true);
      expect(isUncategorizedBookmark({ folderPath: undefined })).toBe(true);
    });

    it('하위 폴더에 배치되어 있으면 false', () => {
      expect(isUncategorizedBookmark({ folderPath: '개발' })).toBe(false);
      expect(isUncategorizedBookmark({ folderPath: 'Bookmarks bar/개발' })).toBe(false);
      expect(isUncategorizedBookmark({ folderPath: 'Other bookmarks/개발' })).toBe(false);
    });
  });

  describe('getLeafFolderName', () => {
    it('전체 경로에서 부모 폴더를 제외한 최종 폴더명만 반환한다', () => {
      expect(getLeafFolderName('Bookmarks bar/개발/프론트엔드')).toBe('프론트엔드');
      expect(getLeafFolderName('Other bookmarks/자료/문서')).toBe('문서');
      expect(getLeafFolderName('개발/웹')).toBe('웹');
      expect(getLeafFolderName('개발')).toBe('개발');
      expect(getLeafFolderName('Bookmarks bar')).toBe('Bookmarks bar');
      expect(getLeafFolderName('Other bookmarks/자료/문서/')).toBe('문서');
    });

    it('빈 경로 또는 undefined 처리', () => {
      expect(getLeafFolderName('')).toBe('');
      expect(getLeafFolderName(undefined)).toBe('');
    });
  });

  describe('sanitizeTechnicalSlashes', () => {
    it('기술 약어 내 슬래시를 하이픈으로 안전 치환한다', () => {
      expect(sanitizeTechnicalSlashes('CDN/WAF')).toBe('CDN-WAF');
      expect(sanitizeTechnicalSlashes('CI/CD')).toBe('CI-CD');
      expect(sanitizeTechnicalSlashes('TCP/IP')).toBe('TCP-IP');
      expect(sanitizeTechnicalSlashes('UI/UX')).toBe('UI-UX');
      expect(sanitizeTechnicalSlashes('I/O')).toBe('I-O');
    });

    it('일반 단어나 빈 문자열은 그대로 보존한다', () => {
      expect(sanitizeTechnicalSlashes('')).toBe('');
      expect(sanitizeTechnicalSlashes('Development')).toBe('Development');
    });
  });

  describe('clampNewFolderDepth', () => {
    it('신규 폴더 경로가 maxDepth를 초과하면 상위 계층만 잘라낸다 (기본 3단계)', () => {
      expect(clampNewFolderDepth('AI/StableDiffusion/Webui/extensions')).toBe('AI/StableDiffusion/Webui');
      expect(clampNewFolderDepth('AI/StableDiffusion/Webui/extensions', 2)).toBe('AI/StableDiffusion');
      expect(clampNewFolderDepth('Dev/Mobile/Debugger/Sub', 3)).toBe('Dev/Mobile/Debugger');
    });

    it('maxDepth 이내인 경로는 그대로 보존한다', () => {
      expect(clampNewFolderDepth('개발/AI/도구')).toBe('개발/AI/도구');
      expect(clampNewFolderDepth('개발/웹')).toBe('개발/웹');
      expect(clampNewFolderDepth('AI')).toBe('AI');
      expect(clampNewFolderDepth('')).toBe('');
    });
  });

  describe('levenshteinDistance', () => {
    it('문자열 간 편집 거리를 정확히 계산한다', () => {
      expect(levenshteinDistance('WegGL', 'WebGL')).toBe(1);
      expect(levenshteinDistance('재태크', '재테크')).toBe(1);
      expect(levenshteinDistance('abc', 'abc')).toBe(0);
      expect(levenshteinDistance('', 'test')).toBe(4);
    });
  });

  describe('findFuzzyMatchingFolder', () => {
    const folders = [
      { id: '1', title: 'WebGL', path: '기타 북마크/Dev/WebGL' },
      { id: '2', title: '재테크', path: '북마크 메뉴/재테크' },
      { id: '3', title: 'Javascript', path: '기타 북마크/Dev/Javascript' },
      { id: '4', title: 'AI', path: '북마크 도구 모음/AI' },
      { id: '5', title: '경제', path: '기타 북마크/생활/경제' }
    ];

    it('알려진 오타(WegGL, 재태크)를 기존 올바른 폴더로 매핑한다', () => {
      const match1 = findFuzzyMatchingFolder('WegGL', folders);
      expect(match1?.title).toBe('WebGL');

      const match2 = findFuzzyMatchingFolder('재태크', folders);
      expect(match2?.title).toBe('재테크');
    });

    it('대소문자 차이나 1글자 오타를 가진 긴 단어를 안전하게 매핑한다', () => {
      const match = findFuzzyMatchingFolder('javascript', folders);
      expect(match?.id).toBe('3');
    });

    it('짧은 단어(AI vs UI, 경제 vs 결제)의 오인 매칭을 가드레일로 방지한다', () => {
      expect(findFuzzyMatchingFolder('UI', folders)).toBeUndefined();
      expect(findFuzzyMatchingFolder('결제', folders)).toBeUndefined();
    });

    it('계층 경로(candDepth >= 2)에서 부모 경로 불일치 시 퍼지 매칭을 거부한다 (AI/Tools vs AI/StableDiffusion/Tools)', () => {
      const foldersWithDeep = [
        { id: '10', title: 'Tools', path: 'Bookmarks bar/AI/StableDiffusion/Tools' }
      ];
      expect(findFuzzyMatchingFolder('AI/Tools', foldersWithDeep)).toBeUndefined();
    });

    it('계층 경로(candDepth >= 2)에서 부모 경로가 일치할 때 리프 오타 교정을 정상 매핑한다 (AI/Toolz vs AI/Tools)', () => {
      const foldersWithParent = [
        { id: '20', title: 'Tools', path: 'Bookmarks bar/AI/Tools' },
        { id: '21', title: 'Tools', path: 'Bookmarks bar/Dev/Tools' }
      ];
      const match = findFuzzyMatchingFolder('AI/Toolz', foldersWithParent);
      expect(match?.id).toBe('20');
      expect(match?.path).toBe('Bookmarks bar/AI/Tools');
    });

    it('단일어 제안(candDepth === 1)이 범용 단어(Tools)일 때 깊은 계층(depth >= 2) 매칭을 전면 차단한다', () => {
      const foldersWithDeep = [
        { id: '30', title: 'Tools', path: 'Bookmarks bar/AI/StableDiffusion/Tools' }
      ];
      expect(findFuzzyMatchingFolder('Tools', foldersWithDeep)).toBeUndefined();
    });
  });
});

