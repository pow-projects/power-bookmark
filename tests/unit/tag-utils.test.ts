import { describe, it, expect } from 'vitest';
import { sanitizeTag, sanitizeTags } from '../../src/lib/bookmarks/tag-utils';

describe('tag-utils', () => {
  describe('sanitizeTag', () => {
    it('removes all whitespace within tag', () => {
      expect(sanitizeTag('machine learning')).toBe('machinelearning');
      expect(sanitizeTag('인공 지능')).toBe('인공지능');
      expect(sanitizeTag('웹 개발')).toBe('웹개발');
      expect(sanitizeTag('프론트엔드   개발 \t 도구')).toBe('프론트엔드개발도구');
    });

    it('strips leading hashtags', () => {
      expect(sanitizeTag('#react')).toBe('react');
      expect(sanitizeTag('###TypeScript')).toBe('TypeScript');
      expect(sanitizeTag('#인공 지능')).toBe('인공지능');
    });

    it('preserves hash symbols that are not leading (e.g. C#)', () => {
      expect(sanitizeTag('C#')).toBe('C#');
      expect(sanitizeTag('tag#1')).toBe('tag#1');
      expect(sanitizeTag('C++')).toBe('C++');
      expect(sanitizeTag('.NET')).toBe('.NET');
      expect(sanitizeTag('Node.js')).toBe('Node.js');
    });

    it('handles null, undefined, numbers, and empty strings', () => {
      expect(sanitizeTag('')).toBe('');
      expect(sanitizeTag('   ')).toBe('');
      expect(sanitizeTag(null)).toBe('');
      expect(sanitizeTag(undefined)).toBe('');
      expect(sanitizeTag(123)).toBe('123');
    });
  });

  describe('sanitizeTags', () => {
    it('sanitizes an array of tags eliminating spaces from each', () => {
      const input = ['machine learning', '인공 지능', '웹 개발', 'React'];
      expect(sanitizeTags(input)).toEqual(['machinelearning', '인공지능', '웹개발', 'React']);
    });

    it('deduplicates tags case-insensitively preserving first casing', () => {
      const input = ['TypeScript', 'typescript', 'Type Script', 'TYPESCRIPT'];
      expect(sanitizeTags(input)).toEqual(['TypeScript']);
    });

    it('handles comma-separated string input', () => {
      const input = 'machine learning, 인공 지능, #웹 개발; React';
      expect(sanitizeTags(input)).toEqual(['machinelearning', '인공지능', '웹개발', 'React']);
    });

    it('filters out empty or whitespace-only tags', () => {
      const input = ['  ', '', '#', '###', 'valid-tag'];
      expect(sanitizeTags(input)).toEqual(['valid-tag']);
    });

    it('handles null and undefined safely', () => {
      expect(sanitizeTags(null)).toEqual([]);
      expect(sanitizeTags(undefined)).toEqual([]);
      expect(sanitizeTags([])).toEqual([]);
    });
  });
});
