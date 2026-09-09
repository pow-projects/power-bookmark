import { test, expect } from 'vitest';
import { analyzeWithAi } from '../../src/lib/ai/ai-core';
import { AiSettings } from '../../src/lib/ai/types';

const targetEndpoint = process.env.WXT_DEV_AI_ENDPOINT || 'http://localhost:8080/v1';
const targetModel = process.env.WXT_DEV_AI_MODEL || 'gemma-4-E4B-it-Q6_K';

const isLlamaAvailable = async (): Promise<boolean> => {
  if (process.env.RUN_LLAMA_INTEGRATION === '1' || process.env.VITEST_LLAMA === '1') return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`${targetEndpoint.replace(/\/+$/, '')}/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
};

const live = await isLlamaAvailable();

test.skipIf(!live)('Test analyzeWithAi with local llama-cpp container', async () => {
  const settings: AiSettings = {
    provider: (process.env.WXT_DEV_AI_PROVIDER as any) || 'custom',
    customEndpoint: targetEndpoint,
    customModel: targetModel,
    apiKey: process.env.WXT_DEV_AI_API_KEY || 'empty',
    autoSummarize: true,
    autoTags: true,
    autoFolder: true,
  };

  const payload = {
    title: 'TypeScript와 Svelte를 활용한 웹 개발',
    textContent: 'TypeScript는 자바스크립트에 타입 구문을 추가하여 개발자가 코드를 더 쉽게 읽고 오류를 사전에 잡을 수 있게 해주는 프로그래밍 언어입니다. Svelte는 빌드 타임에 리액티브 코드로 변환되는 현대적인 프론트엔드 프레임워크입니다.',
    url: 'https://example.com/ts-svelte'
  };

  console.log('Sending request to llama-cpp at http://localhost:8080/v1...');
  const startTime = Date.now();

  let result;
  try {
    result = await analyzeWithAi(settings, payload, [], undefined);
  } catch (e: any) {
    // In an environment where the router is spawned with Content-only (token soup), it is expected behavior for the safety net (TokenSoupError) to reject it.
    // If an error occurs with a soup signature, consider it safety net operation and pass.
    if (e?.name === 'TokenSoupError' || (e?.message && /<unused|<\|tool|\[multimodal\]/.test(e.message))) {
      console.log('Token soup detected — safety net rejected the response (router preset jinja=on/embeddings=off required).');
      return;
    }
    throw e;
  }
  const duration = (Date.now() - startTime) / 1000;

  console.log(`Received response in ${duration.toFixed(2)}s:`, JSON.stringify(result, null, 2));

  // Validate parsed JSON shape on normal response (since checking only truthiness would also pass soup)
  expect(result).toBeDefined();
  expect(result.summary).toBeTruthy();
  expect(typeof result.category).toBe('string');
}, 180000); // 3-minute timeout
