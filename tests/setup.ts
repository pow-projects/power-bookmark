import { vi } from 'vitest';
import { createI18nMock } from './helpers/i18n-mock';

(globalThis as any).i18n = createI18nMock();
(globalThis as any).defineBackground = (fn: any) => ({ main: fn });

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
