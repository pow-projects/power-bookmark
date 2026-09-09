import { describe, it, expect } from 'vitest';
import { isTokenSoup, parseAnalysisResult } from '../../src/lib/ai/types';
import { isLocalEndpoint, getSafeMaxTokens, assertValidModelOutput, TokenSoupError, isPermanentAiError } from '../../src/lib/ai/llama-safety';

describe('isTokenSoup', () => {
  it('detects llama.cpp content-only token soup signatures', () => {
    expect(isTokenSoup('<unused28><unused39>...')).toBe(true);
    expect(isTokenSoup('<|start_of_turn|>')).toBe(true);
    expect(isTokenSoup('[multimodal]')).toBe(true);
  });

  it('returns false for normal text and empty string', () => {
    expect(isTokenSoup('정상적인 한국어 요약 텍스트입니다.')).toBe(false);
    expect(isTokenSoup('')).toBe(false);
  });
});

describe('isLocalEndpoint', () => {
  it('detects localhost and loopback endpoints', () => {
    expect(isLocalEndpoint('http://localhost:8080/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
  });

  it('detects private network ranges', () => {
    expect(isLocalEndpoint('http://192.168.0.5:8000/v1')).toBe(true);
    expect(isLocalEndpoint('http://10.0.0.1:8080')).toBe(true);
    expect(isLocalEndpoint('http://172.20.0.2:8080')).toBe(true);
  });

  it('returns false for cloud endpoints and undefined', () => {
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isLocalEndpoint(undefined)).toBe(false);
  });
});

describe('getSafeMaxTokens', () => {
  it('enforces 2048 floor for local endpoints', () => {
    expect(getSafeMaxTokens('http://localhost:8080/v1')).toBe(2048);
    expect(getSafeMaxTokens('http://localhost:8080/v1', 800)).toBe(2048);
    expect(getSafeMaxTokens('http://localhost:8080/v1', 4096)).toBe(4096);
  });

  it('passes through user-specified tokens for cloud endpoints', () => {
    expect(getSafeMaxTokens('https://api.openai.com/v1')).toBeUndefined();
    expect(getSafeMaxTokens('https://api.openai.com/v1', 1024)).toBe(1024);
  });
});

describe('assertValidModelOutput', () => {
  it('throws TokenSoupError on token soup', () => {
    expect(() => assertValidModelOutput('<unused28><unused39>')).toThrow(TokenSoupError);
  });

  it('passes for normal output', () => {
    expect(() => assertValidModelOutput('{"summary":"정상"}')).not.toThrow();
  });
});

describe('parseAnalysisResult soup guard and reasoning stripping', () => {
  it('still parses valid JSON normally', () => {
    const result = parseAnalysisResult('{"summary":"정상","category":"개발"}');
    expect(result.summary).toBe('정상');
    expect(result.category).toBe('개발');
  });

  it('strips <think> and <thought> tags before parsing reasoning model output', () => {
    const result = parseAnalysisResult('<think>이 문서는 React에 관한 글입니다.</think>```json\n{"summary":"React 개발 가이드","category":"AI/ML"}\n```');
    expect(result.summary).toBe('React 개발 가이드');
    expect(result.category).toBe('AI/ML');
  });

  it('returns fallback failure result on token soup without using title as folder name', () => {
    const result = parseAnalysisResult('<unused28>garbage');
    expect(result.summary).toBe('Unable to generate summary.');
    expect(result.suggestedFolderName).toBe('');
  });
});

describe('isPermanentAiError', () => {
  it('detects permanent errors like 401, 403, 404, auth errors and quota issues', () => {
    expect(isPermanentAiError({ status: 401, message: 'Unauthorized' })).toBe(true);
    expect(isPermanentAiError({ statusCode: 404, message: 'Model not found' })).toBe(true);
    expect(isPermanentAiError(new Error('Invalid API key provided'))).toBe(true);
    expect(isPermanentAiError(new Error('You exceeded your current quota'))).toBe(true);
    expect(isPermanentAiError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isPermanentAiError(new Error('AI provider is not configured'))).toBe(true);
    expect(isPermanentAiError(new TokenSoupError())).toBe(true);
  });

  it('returns false for transient errors', () => {
    expect(isPermanentAiError(new Error('ETIMEDOUT: Connection timed out'))).toBe(false);
    expect(isPermanentAiError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isPermanentAiError(null)).toBe(false);
  });
});
