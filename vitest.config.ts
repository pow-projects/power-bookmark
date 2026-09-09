import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [svelte({
    configFile: false,
    preprocess: [vitePreprocess()],
    compilerOptions: {
      compatibility: {
        componentApi: 4,
      },
    },
    // WXT auto-imports `i18n` (injected by @wxt-dev/i18n module at extension build time);
    // tests provide it via globalThis in tests/setup.ts. Same suppression as wxt.config.ts.
    onwarn(warning, handler) {
      if (warning.code === 'missing-declaration' && warning.message.includes("'i18n'")) return;
      handler?.(warning);
    },
  })],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
      '@': path.resolve(__dirname, './src'),
      '@@': path.resolve(__dirname, './'),
      '~~': path.resolve(__dirname, './')
    },
    // By default, Vitest resolves the 'svelte' package under SSR conditions, linking to the
    // SSR runtime (ssr.js) where onMount/onDestroy are no-ops. Under jsdom, this prevents Svelte
    // component lifecycles from executing at all, causing popup/component tests to get stuck in infinite loading.
    // Adding the 'browser' condition directs it to use the client runtime (index.js), ensuring
    // onMount and other lifecycle hooks work properly.
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/management.html'
      }
    },
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts']
  }
});
