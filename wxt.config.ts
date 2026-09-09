import { defineConfig } from 'wxt';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Auto-detect Chrome (Chrome for Testing) installed by agent-browser
// Paths change per version, so pick the latest version among chrome-*.
// Sets multiple home directories as candidates since HOME may vary across shells/terminals.
function resolveChromeBinary(): string | undefined {
  // 1. Explicit env override
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;

  // 2. agent-browser cache: current HOME + known fixed path candidates
  const homeDirs = [
    homedir(),
    process.env.HOME,
  ].filter((d): d is string => !!d && existsSync(d));

  const candidates = new Set<string>();
  for (const home of homeDirs) {
    try {
      const cacheDir = join(home, '.agent-browser', 'browsers');
      if (!existsSync(cacheDir)) continue;
      const versions = readdirSync(cacheDir)
        .filter((d) => d.startsWith('chrome-'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        candidates.add(join(cacheDir, v, 'chrome'));
      }
    } catch {
      /* fall through */
    }
  }
  const found = [...candidates]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .find((p) => existsSync(p));
  if (found) return found;

  // 3. Search for chromium/chrome in PATH
  const pathBins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const bin of pathBins) {
    try {
      const resolved = execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim();
      if (resolved) return resolved;
    } catch {
      /* not in PATH */
    }
  }

  // 4. Fallback: return undefined so WXT uses native platform auto-detection
  return undefined;
}

// linkedom SSR environment eventPhase setter polyfill for svelte-hmr compatibility
try {
  if (typeof globalThis.Event !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(globalThis.Event.prototype, 'eventPhase');
    if (!desc || !desc.set) {
      Object.defineProperty(globalThis.Event.prototype, 'eventPhase', {
        get() {
          return this._eventPhase ?? 0;
        },
        set(v) {
          this._eventPhase = v;
        },
        configurable: true,
      });
    }
  }
} catch {
  // ignore
}

// Configuration for WXT + Svelte
const detectedChromeBinary = resolveChromeBinary();

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte', '@wxt-dev/i18n/module'],
  vite: () => ({
    build: {
      chunkSizeWarningLimit: 1200,
    },
  }),
  svelte: {
    vite: {
      hot: false,
      compilerOptions: {
        compatibility: {
          componentApi: 4,
        },
      },
      onwarn(warning, handler) {
        if (warning.code === 'missing-declaration' && warning.message.includes("'i18n'")) {
          return;
        }
        handler(warning);
      },
    },
  },
  hmr: false,
  webExt: {
    disabled: process.env.WXT_RUNNER_OPEN === 'false',
    binaries: detectedChromeBinary ? { chrome: detectedChromeBinary } : undefined,
    chromiumArgs: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${process.env.CHROMIUM_REMOTE_DEBUGGING_PORT || '9222'}`
    ],
  },
  manifest: ({ browser }) => {
    const permissions = [
      'contextMenus',
      'bookmarks',
      'tabs',
      'storage',
      'identity',
      'activeTab',
      'scripting',
      'alarms',
      'downloads'
    ];
    if (browser !== 'firefox') {
      permissions.push('offscreen');
    }
    return {
      name: '__MSG_extensionName__',
      description: '__MSG_extensionDescription__',
      default_locale: 'en',
      permissions,
      host_permissions: ['<all_urls>'],
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'none';"
      },
      browser_specific_settings: {
        gecko: {
          id: 'powerbookmark@0deep.github.io',
          strict_min_version: '142.0',
          data_collection_permissions: {
            required: ['none']
          }
        }
      },
      action: {
        default_title: '__MSG_extensionName__',
        default_icon: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png'
        }
      },
      icons: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png'
      }
    };
  }
});
