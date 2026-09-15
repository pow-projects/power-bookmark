import { describe, it, expect } from 'vitest';
import { parseCustomHeaders } from '../../src/lib/ai/custom-headers';
import { getProvider } from '../../src/lib/ai/provider-registry';
import { fetchAvailableModels } from '../../src/lib/ai/fetch-models';
import { vi } from 'vitest';

describe('parseCustomHeaders', () => {
  it('handles empty / undefined inputs', () => {
    expect(parseCustomHeaders('')).toEqual({});
    expect(parseCustomHeaders(undefined)).toEqual({});
    expect(parseCustomHeaders(null)).toEqual({});
    expect(parseCustomHeaders('   ')).toEqual({});
  });

  it('parses JSON format headers', () => {
    const json = JSON.stringify({
      'X-Custom-Auth': 'token123',
      'X-Org-Id': 'org-456'
    });
    expect(parseCustomHeaders(json)).toEqual({
      'X-Custom-Auth': 'token123',
      'X-Org-Id': 'org-456'
    });
  });

  it('parses multi-line Key: Value format headers', () => {
    const raw = `
      X-Custom-Header: value1
      Authorization: Bearer secret-token
      X-Gateway-Route: us-east-1:8080
      # this is a comment
      // another comment
    `;
    expect(parseCustomHeaders(raw)).toEqual({
      'X-Custom-Header': 'value1',
      'Authorization': 'Bearer secret-token',
      'X-Gateway-Route': 'us-east-1:8080'
    });
  });

  it('returns object as-is if already a Record', () => {
    const obj = { 'X-Test': '123' };
    expect(parseCustomHeaders(obj)).toBe(obj);
  });
});

describe('Custom API provider custom headers integration', () => {
  it('injects customHeaders into createModel for custom provider', () => {
    const customProvider = getProvider('custom');
    expect(customProvider).toBeDefined();

    const model = customProvider!.createModel('', 'llama-model', {
      customEndpoint: 'http://localhost:8080/v1',
      customHeaders: 'X-App-Id: my-app\nX-Custom-Key: key-999'
    }) as any;

    expect(model).toBeDefined();
    const headers = typeof model.config?.headers === 'function' ? model.config.headers() : model.config?.headers;
    expect(headers['x-app-id']).toBe('my-app');
    expect(headers['x-custom-key']).toBe('key-999');
  });

  it('passes customHeaders to fetchAvailableModels for custom provider', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] })
    });
    globalThis.fetch = mockFetch;

    try {
      await fetchAvailableModels('custom', '', 'http://localhost:8080/v1', 'X-Gateway: cluster-1');
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8080/v1/models', expect.objectContaining({
        headers: expect.objectContaining({
          'X-Gateway': 'cluster-1'
        })
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
