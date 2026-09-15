import { describe, it, expect } from 'vitest';
import { formatApproximateAiError } from '../../src/lib/ai/ai-error-formatter';
import { retryBackoffMs, RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_FACTOR, RETRY_BACKOFF_MAX_MS } from '../../src/lib/ai/queue-config';

describe('AI Error Formatter & Retry Backoff', () => {
  describe('retryBackoffMs', () => {
    it('uses 5s base and factor 3 (5s -> 15s -> capped at 30s)', () => {
      expect(RETRY_BACKOFF_BASE_MS).toBe(5_000);
      expect(RETRY_BACKOFF_FACTOR).toBe(3);
      expect(RETRY_BACKOFF_MAX_MS).toBe(30_000);

      expect(retryBackoffMs(1)).toBe(5_000);
      expect(retryBackoffMs(2)).toBe(15_000);
      expect(retryBackoffMs(3)).toBe(30_000);
      expect(retryBackoffMs(4)).toBe(30_000);
    });
  });

  describe('formatApproximateAiError', () => {
    it('handles undefined or null error', () => {
      expect(formatApproximateAiError(undefined)).toBe(i18n.t('ai.analysisError'));
      expect(formatApproximateAiError('')).toBe(i18n.t('ai.analysisError'));
    });

    it('formats quota and rate limit errors (429)', () => {
      expect(formatApproximateAiError('429 Too Many Requests')).toBe(i18n.t('ai.errorQuota'));
      expect(formatApproximateAiError('You exceeded your current quota')).toBe(i18n.t('ai.errorQuota'));
      expect(formatApproximateAiError('Rate limit reached')).toBe(i18n.t('ai.errorQuota'));
    });

    it('formats authentication & authorization errors (401 / 403 / API Key)', () => {
      expect(formatApproximateAiError('401 Unauthorized: Invalid API key')).toBe(i18n.t('ai.errorAuth'));
      expect(formatApproximateAiError('Incorrect API key provided')).toBe(i18n.t('ai.errorAuth'));
      expect(formatApproximateAiError('403 Forbidden')).toBe(i18n.t('ai.errorAuth'));
    });

    it('formats model not found errors (404)', () => {
      expect(formatApproximateAiError('404 The model gpt-5 does not exist')).toBe(i18n.t('ai.errorModelNotFound'));
      expect(formatApproximateAiError('model_not_found')).toBe(i18n.t('ai.errorModelNotFound'));
    });

    it('formats timeout and abort errors', () => {
      expect(formatApproximateAiError('Request timed out after 120000ms')).toBe(i18n.t('ai.errorTimeout'));
      expect(formatApproximateAiError('AbortError: The operation was aborted')).toBe(i18n.t('ai.errorTimeout'));
      expect(formatApproximateAiError('Deadline exceeded')).toBe(i18n.t('ai.errorTimeout'));
    });

    it('formats network connection errors', () => {
      expect(formatApproximateAiError('Failed to fetch: net::ERR_CONNECTION_REFUSED')).toBe(i18n.t('ai.errorNetwork'));
      expect(formatApproximateAiError('connect ECONNREFUSED 127.0.0.1:11434')).toBe(i18n.t('ai.errorNetwork'));
      expect(formatApproximateAiError('NetworkError when attempting to fetch resource')).toBe(i18n.t('ai.errorNetwork'));
    });

    it('formats token soup and context length errors', () => {
      expect(formatApproximateAiError('AI response is token soup. Please check router.')).toBe(i18n.t('ai.errorTokenSoup'));
      expect(formatApproximateAiError('maximum context length is 4096 tokens')).toBe(i18n.t('ai.errorTokenSoup'));
    });

    it('formats unconfigured AI errors', () => {
      expect(formatApproximateAiError('AI provider is not configured')).toBe(i18n.t('ai.errorNotConfigured'));
    });

    it('formats 5xx server errors', () => {
      expect(formatApproximateAiError('500 Internal Server Error')).toBe(i18n.t('ai.errorServerError'));
      expect(formatApproximateAiError('502 Bad Gateway')).toBe(i18n.t('ai.errorServerError'));
      expect(formatApproximateAiError('503 Service Unavailable')).toBe(i18n.t('ai.errorServerError'));
    });

    it('falls back to concise cleaned message for unknown errors', () => {
      expect(formatApproximateAiError('Custom system glitch')).toBe('Custom system glitch');
      const longMsg = 'A'.repeat(50);
      const formatted = formatApproximateAiError(longMsg);
      expect(formatted.length).toBeLessThanOrEqual(40);
      expect(formatted.endsWith('...')).toBe(true);
    });
  });
});
