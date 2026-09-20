import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatTime } from '../../src/lib/ui/date-formatter';

describe('date-formatter', () => {
  const testTimestamp = new Date(2026, 8, 20, 14, 5, 9).getTime(); // 2026.09.20 14:05:09

  describe('formatDate', () => {
    it('formats timestamp as YYYY.MM.DD', () => {
      expect(formatDate(testTimestamp)).toBe('2026.09.20');
    });

    it('handles undefined or invalid timestamp gracefully', () => {
      expect(formatDate(undefined)).toBe('');
      expect(formatDate(NaN)).toBe('');
      expect(formatDate(0)).toBe('');
    });
  });

  describe('formatDateTime', () => {
    it('formats timestamp as YYYY.MM.DD HH:mm without seconds by default', () => {
      expect(formatDateTime(testTimestamp)).toBe('2026.09.20 14:05');
    });

    it('formats timestamp as YYYY.MM.DD HH:mm:ss when includeSeconds is true', () => {
      expect(formatDateTime(testTimestamp, true)).toBe('2026.09.20 14:05:09');
    });

    it('handles invalid input gracefully', () => {
      expect(formatDateTime(undefined)).toBe('');
      expect(formatDateTime(NaN)).toBe('');
      expect(formatDateTime(0)).toBe('');
    });
  });

  describe('formatTime', () => {
    it('formats timestamp as HH:mm', () => {
      expect(formatTime(testTimestamp)).toBe('14:05');
    });

    it('formats timestamp as HH:mm:ss when includeSeconds is true', () => {
      expect(formatTime(testTimestamp, true)).toBe('14:05:09');
    });

    it('handles invalid input gracefully', () => {
      expect(formatTime(undefined)).toBe('');
      expect(formatTime(NaN)).toBe('');
      expect(formatTime(0)).toBe('');
    });
  });
});
