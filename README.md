<p align="center">
  <img src="src/assets/icons/app-icon-128.png" alt="PowerBookmark" width="96" height="96" />
</p>

# PowerBookmark

A bookmark extension for Chrome (MV3) and Firefox that handles organizing, summarizing, offline archiving, and cloud sync of your bookmarks.

## Features

- **AI categorization & summaries** — reads the saved page's content, suggests the best folder from your existing hierarchy, and fills in tags plus a short summary on the bookmark.
- **Dashboard** — collection stats, frequently visited sites, and dead-link detection for batch cleanup.
- **Offline archive** — saves a full page as a single HTML file with inlined CSS, fonts, and images (ad/tracking scripts stripped), stored gzipped. View snapshots offline via the built-in viewer.
- **Cloud sync** — two-way merge across Google Drive, OneDrive, Dropbox, and WebDAV, with conflict resolution. Credentials are encrypted with AES-256.

## Development

```bash
npm install

# Dev server (extension auto-reload)
npm run dev:chrome
npm run dev:firefox

# Type check / tests
npm run compile
npm test

# Production build & store zip
npm run build:chrome && npm run zip:chrome
npm run build:firefox && npm run zip:firefox
```

Build output lands in `output/chrome-mv3` and `output/firefox`.

## Tech stack

- [WXT](https://wxt.dev) — extension scaffolding (Chrome MV3 / Firefox)
- Svelte + TypeScript, `@wxt-dev/i18n` (en/ko)
- Dexie (IndexedDB) — bookmarks, archives, and AI queue storage
- Vercel AI SDK — Anthropic / OpenAI / Google providers

## License

[MIT](LICENSE)
