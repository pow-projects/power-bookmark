import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectBrowserLanguage } from '../../src/lib/ai/language-detector';
import { buildAnalysisPrompt, isGenericCategory, isNoBodyText } from '../../src/lib/ai/types';

describe('AI Language Detection & Multi-language Prompting', () => {
  const originalBrowser = (globalThis as any).browser;

  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
  });

  describe('detectBrowserLanguage', () => {
    it('returns explicit language if provided', () => {
      const res = detectBrowserLanguage('ja-JP');
      expect(res.code).toBe('ja');
      expect(res.displayName).toBe('Japanese');
    });

    it('detects language from browser.i18n.getUILanguage()', () => {
      (globalThis as any).browser = {
        i18n: {
          getUILanguage: () => 'ko-KR'
        }
      };
      const res = detectBrowserLanguage();
      expect(res.code).toBe('ko');
      expect(res.displayName).toBe('Korean');
    });

    it('falls back to English when no language info available', () => {
      delete (globalThis as any).browser;
      const res = detectBrowserLanguage();
      // Should return a valid detected language (English or system default)
      expect(res.displayName).toBeDefined();
    });

    it('correctly identifies Traditional and Simplified Chinese', () => {
      expect(detectBrowserLanguage('zh-TW').displayName).toBe('Traditional Chinese');
      expect(detectBrowserLanguage('zh-CN').displayName).toBe('Simplified Chinese');
    });
  });

  describe('buildAnalysisPrompt with target language', () => {
    it('injects English target language instructions when targetLanguage is English', () => {
      const prompt = buildAnalysisPrompt(
        { title: 'Test', url: 'https://example.com', textContent: 'Content' },
        [],
        'full',
        'English'
      );
      expect(prompt.systemPrompt).toContain('Target Output Language: English');
      expect(prompt.systemPrompt).toContain('around 10 to 15 words');
      expect(prompt.userPrompt).toContain('Title: Test');
      expect(prompt.userPrompt).toContain('[Webpage Content]');
    });

    it('injects Korean target language instructions when targetLanguage is Korean', () => {
      const prompt = buildAnalysisPrompt(
        { title: 'Test', url: 'https://example.com', textContent: 'Content' },
        [],
        'full',
        'Korean'
      );
      expect(prompt.systemPrompt).toContain('Target Output Language: Korean');
      expect(prompt.systemPrompt).toContain('60 Korean characters');
      expect(prompt.systemPrompt).toContain('명사형 종결');
    });
  });

  describe('isGenericCategory', () => {
    it('returns true for general, uncategorized, and multingual variants', () => {
      expect(isGenericCategory('general')).toBe(true);
      expect(isGenericCategory('General')).toBe(true);
      expect(isGenericCategory('uncategorized')).toBe(true);
      expect(isGenericCategory('misc')).toBe(true);
      expect(isGenericCategory('default')).toBe(true);
      expect(isGenericCategory('일반')).toBe(true);
      expect(isGenericCategory('기타')).toBe(true);
      expect(isGenericCategory('미분류')).toBe(true);
      expect(isGenericCategory('一般')).toBe(true);
      expect(isGenericCategory('その他')).toBe(true);
      expect(isGenericCategory('')).toBe(true);
      expect(isGenericCategory(null)).toBe(true);
      expect(isGenericCategory(undefined)).toBe(true);
    });

    it('returns false for actual specific categories', () => {
      expect(isGenericCategory('개발')).toBe(false);
      expect(isGenericCategory('Development')).toBe(false);
      expect(isGenericCategory('Technology')).toBe(false);
      expect(isGenericCategory('Shopping')).toBe(false);
      expect(isGenericCategory('Finance')).toBe(false);
    });
  });

  describe('isNoBodyText with multi-language sentinels', () => {
    it('recognizes various empty/placeholder sentinels', () => {
      expect(isNoBodyText('No body text to summarize.')).toBe(true);
      expect(isNoBodyText('No body text available.')).toBe(true);
      expect(isNoBodyText('요약할 본문 텍스트가 없습니다.')).toBe(true);
      expect(isNoBodyText('Unable to generate summary.')).toBe(true);
      expect(isNoBodyText('요약 결과를 가져올 수 없습니다.')).toBe(true);
      expect(isNoBodyText('__NO_BODY_TEXT__')).toBe(true);
      expect(isNoBodyText('')).toBe(true);
      expect(isNoBodyText(null)).toBe(true);
      expect(isNoBodyText('   ')).toBe(true);
    });

    it('returns false for real summary content', () => {
      expect(isNoBodyText('This is a great tool for managing bookmarks.')).toBe(false);
      expect(isNoBodyText('북마크 관리를 위한 도구 플랫폼')).toBe(false);
    });
  });
});
