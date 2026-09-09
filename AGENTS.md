# PowerBookmark Project Guidelines

## 1. Project Overview & Architecture Stack

PowerBookmark is a high-performance, privacy-first Chrome/Firefox browser extension for bookmark management, AI categorization, full-page archiving, and multi-cloud sync.

- **Extension Framework**: WXT (Web eXtension Tools) v0.21 targeting Chrome MV3 and Firefox MV2/MV3.
- **Frontend Stack**: Svelte (Svelte 5 runes & Svelte 4 componentApi compatible), TypeScript, `@wxt-dev/i18n`, Chart.js.
- **Database & Storage**: Dexie IndexedDB (`src/lib/db.ts`), Chrome `storage.local`, browser bookmarks tree.
- **Testing**: Vitest (unit/integration), Playwright (E2E), Chrome DevTools MCP.
- **Entrypoints Separation**:
  - `src/entrypoints/popup/`: Ephemeral quick-action card for bookmark creation, editing, and immediate archiving/AI triggers.
  - `src/entrypoints/management/`: Full-tab SPA (`management.html`) hosting Dashboard, Bookmark Catalog, and Unified Settings.
  - `src/entrypoints/viewer/`: Sandboxed offline HTML archive snapshot viewer (`viewer.html`).
  - `src/entrypoints/offscreen/`: Dedicated DOM parsing & extraction worker for Chrome MV3.
  - `src/entrypoints/background.ts`: Service worker managing sync alarms, AI queue, archive processing, and context menus.

---

## 2. Process & Cross-Browser MV3 Management

### Chrome Process Termination
Chrome manages child processes via `wait()` in the main process. Killing only child processes via `pkill` leaves zombie processes because the parent cannot detect their exit. Therefore, termination must always be performed through the parent process:
- **WXT Termination:** `Ctrl+C` (WXT performs cleanup)
- **Test Termination:** `context.close()` (Playwright performs cleanup)
- **Other Cases:** `kill -TERM <PARENT_PID>` (SIGTERM is the graceful termination flag)

### Cross-Browser MV3 Divergences
- **Offscreen Permission**: Firefox MV3 does not support the `offscreen` permission. Keep `permissions.push('offscreen')` conditional on `browser !== 'firefox'` in `wxt.config.ts`.
- **Context Menus**: In `browser.contextMenus.create()`, use contexts `['browser_action']` on Firefox and `['action']` on Chrome MV3 (`src/entrypoints/background.ts`).
- **DOM Parsing**: Use `src/entrypoints/offscreen/` on Chrome MV3; perform direct parsing on Firefox (`import.meta.env.FIREFOX`).

---

## 3. Build, Lint & Testing Standards

### Commands
- `npm run compile` — TypeScript compilation & type checking
- `npm test` — Vitest unit and integration test suite
- `npm run build:chrome` — Chrome MV3 production build verification
- `npm run build:firefox` — Firefox MV3 production build verification
- MCP Testing — Connect chrome-devtools server and check in `chrome://extensions/`
- E2E Testing Agent — `@extension-tester` (`.opencode/agents/extension-tester.md`): Analyze changes → Plan → Run chrome-devtools → Report

### Vitest Runtime Configuration
- **Browser Condition Resolution**: `vitest.config.ts` must maintain `conditions: ['browser']` under `resolve`. Without this, Vitest resolves Svelte modules under SSR mode (`ssr.js`), causing `onMount` and component lifecycles to no-op in `jsdom`.
- **Environment**: `jsdom` with `url: 'http://localhost/management.html'`.

### Mocking Guidelines for Tests
- **Browser Global**: Use `vi.stubGlobal('browser', { ... })` and `vi.hoisted()` for mocks referenced within `vi.mock()` factories.
- **Dexie Mock Chains**: Mock Dexie tables dynamically with chainable queries (`.where().equals()`, `.filter()`, `.first()`, `.toArray()`, `.add()`, `.put()`, `.delete()`, `.transaction()`). Ensure tables evaluate store arrays dynamically at call time.
- **Timer & Queue Backoff**: In queue/retry tests, mock `retryBackoffMs` to minimal values (5ms) to prevent test timeouts and multi-second slowdowns.
- **Test State Hygiene**: Always clear mock tables and reset queue singletons (`_resetArchiveQueueForTest()`, `vi.clearAllMocks()`, `vi.unstubAllGlobals()`) in `beforeEach` / `afterEach`.

---

## 4. Design System — "Archival Catalog"

- **Tokens**: Defined in `src/assets/styles/design-system.css` and `src/assets/styles/components.css`.
- **Typography Tokens** (Locally bundled, imported in `src/entrypoints/*/main.ts`):
  - Body & Titles: Pretendard Variable (`--font-primary`, `--font-accent`)
  - Numbers, Badges, Tags, Metadata, Dates: IBM Plex Mono (`--font-mono`)
  - Latin Wordmark Only: Outfit (`--font-display`)
- **Color Tokens**:
  - Primary: Ribbon Red (`--color-primary`: `#D6453D` light / `#F0665C` dark)
  - Success: Stamp Teal (`--color-success`: `#0F766E` light / `#2DD4BF` dark)
  - Warning / Info: Amber (`--color-warning`: `#B45309` light / `#F59E0B` dark)
  - Danger: Crimson (`--color-danger`: `#B93A33` light / `#F0665C` dark)
- **Surface Invariant**:
  - `.glass-panel` is **strictly restricted to floating UI only** (Modals, Dropdown menus, Toast notifications).
  - Base pages, sidebars, cards, and list tables must use solid surfaces (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`).
- **Signatures**:
  - Active sidebar navigation item uses the left ribbon marker (`clip-path` notch).
  - Stat cards feature a top 3px hairline accent and mono eyebrows.
  - Stamp Badges (`.stamp-badge`): Mono font, uppercase, bordered pill style.
- **Strict "No Emoji Icons" Rule**:
  - **Never use Unicode emojis as UI icons** (e.g., no 📁, 🗑️, ⚙️, 💾).
  - **Always use `<Icon name="..." size={...} />`** (`src/components/shared/Icon.svelte`).
  - Register any missing Lucide/Feather SVG paths directly in `Icon.svelte`.

---

## 5. Frontend Lifecycle, Svelte Reactivity & i18n Rules

### Svelte Reactivity & Collection Invariants
- **Set/Map/Object Reassignment**: Mutating a `Set`, `Map`, or `Object` in place (`selectedIds.add(id)`) does NOT trigger Svelte reactivity. Always reassign references:
  ```ts
  selectedIds.add(id);
  selectedIds = selectedIds; // or selectedIds = new Set(selectedIds);
  choices = { ...choices, [id]: action };
  ```
- **Resource Cleanup in `onDestroy`**: Any component creating `URL.createObjectURL`, `AbortController`, `setInterval`, or DOM event listeners must explicitly clean them up on teardown (`URL.revokeObjectURL`, `abort()`, `clearInterval`).

### Popup Lifecycle & Autosave Safeguards
- **Ephemeral Lifecycle**: The popup can close at any time. Heavy or long-running async tasks (AI analysis, full-page archive capture) must be delegated to the background service worker via `browser.runtime.sendMessage`.
- **Autosave vs Delete Mutex**: In `src/entrypoints/popup/App.svelte`, initiating a deletion (`handleDeleteBookmark`) must immediately cancel `autosaveDebounceTimer` and set `isDeleting = true` before calling DB delete to prevent debounced autosave resurrection.
- **Action Feedback Stamp**: Show the success state stamp for 800ms before calling `window.close()` to ensure the user receives visual feedback.

### Modal Interaction Invariants
- **Focus Trapping**: Modals (`Modal.svelte`) must save `previouslyFocused = document.activeElement`, trap Tab/Shift-Tab key navigation within the dialog, and restore focus on close.
- **Safe Backdrop Handling**: Use `on:mousedown={handleBackdropClick}` with `e.target === e.currentTarget` to prevent accidental dismissal when text selection drags across the backdrop.

### i18n & Localization Invariants
- **Zero Hardcoded Strings**: All UI text must be retrieved via `i18n.t('domain.key', { param })`.
- **Dual-Dictionary Synchronicity**: Any key added or edited must be maintained simultaneously in both `src/locales/en.yml` and `src/locales/ko.yml`.
- **Date Formatting**: Use `formatDate(timestamp)` from `src/lib/ui/date-formatter.ts` (`YYYY.MM.DD` mono format) instead of locale-dependent `toLocaleDateString()`.

---

## 6. Dexie Database & Storage Integrity Rules

### Split Transaction Boundary Rule (CRITICAL)
- **Never `await` non-Dexie async APIs inside Dexie transactions**:
  `browser.bookmarks.*`, `fetch()`, `crypto.*`, and IPC calls must NEVER be executed inside `db.transaction('rw', ...)`.
- **Why**: IndexedDB automatically commits transactions when the JavaScript microtask queue empties during external async operations, causing fatal `PrematureCommitError` on subsequent Dexie writes.
- **Correct Pattern**: Batch all browser tree lookups and network requests beforehand, then execute Dexie writes in a dedicated atomic transaction.

### Multi-Context Coordination & Querying Safety
- **Versionchange Handler**: Keep `db.on('versionchange', () => db.close())` registered (`src/lib/db.ts`) so background and offscreen contexts close gracefully when the popup or management page opens a newer schema version.
- **Unindexed Filtering**: Attributes not indexed in `src/lib/db.ts` (such as `aiStatus`) must be queried using `table.filter(fn)` rather than `table.where('aiStatus')` to avoid Dexie runtime `SchemaError`.
- **Safe ASCII Filenames**: Chrome's `downloads.download` API validates filenames via `net::IsSafePortableRelativePath` and rejects non-ASCII strings. Export routines in `export-manager.ts` must fallback to `toSafeAsciiFilename()` on error.

---

## 7. Bookmark Identity & Sync Integrity Rules

### 1. `syncId` vs `bookmarkId` Role Separation
- **`syncId` (Global Unique Immutable Key)**:
  - Sole global identifier for cloud synchronization (JSON), deletion propagation (Tombstone), and cloud archive files (`archives/<syncId>.html`).
  - Once created, it must NEVER be arbitrarily modified or reissued.
- **`bookmarkId` (Local Browser Node ID)**:
  - Ephemeral, local tree node ID issued by Chrome/Firefox (e.g., `"123"`). Must never be shared across devices or used as an identity key.

### 2. Deterministic `syncId` Generation & Immutability Principle
- **Deterministic Generation (`generateDeterministicSyncId(url)`)**:
  - Every bookmark created locally (`BookmarkManager.createBookmark`, `onCreated`, `syncAll`), normalized from the cloud (`normalizeCloudBookmark`), or resolved from conflicts (`ConflictResolverModal`), **must always use URL-based deterministic UUID v5 ([`generateDeterministicSyncId`](file:///workspace/src/lib/bookmarks/url-normalizer.ts#L75))**.
  - Using random `crypto.randomUUID()` causes local and cloud IDs to mismatch and leads to severe ID churn.
  - `crypto.randomUUID()` is strictly limited as a fallback only when multiple distinct bookmarks share the exact same URL on the same device to prevent Dexie `&syncId` unique constraint collisions.
- **Preserving Existing `syncId`**:
  - During `syncAll()`, `onChanged`, or `onMoved`, never overwrite or reissue the `syncId` of records that already exist in the DB.
- **Unadopted Bookmark Adoption during `syncAll()`**:
  - If an existing DB record's `bookmarkId` is missing from the browser tree, search for an unadopted browser node with the same normalized URL and adopt its `bookmarkId` rather than emitting false tombstones.

### 3. Pre-merge Identity Reconciliation & Dexie Unique Index Protection
- **1:1 Adoption**:
  - When matching cloud and local bookmarks by URL, adopt the cloud `syncId` 1:1 regardless of content differences (title, description, tags, folderPath) to preserve local DB row IDs and archive associations.
- **Preventing Unique Index (`&syncId`) Collisions**:
  - Track `localSyncIdSet` and `adoptedSyncIds` sets to proactively prevent `ConstraintError` caused by duplicate `syncId` updates within the same transaction.

### 4. Folder Path Normalization & Creation Mutex
- **Pure Functions**:
  - Use `folder-utils.ts` pure functions (`isSameFolderLocation`, `normalizeFolderPath`, `isUncategorizedBookmark`) to prevent false positives from localized root names ("북마크바" vs "Bookmarks bar") or trailing slashes.
- **Preventing Circular Dependencies**:
  - Keep folder comparison and normalization logic as pure functions in `src/lib/bookmarks/folder-utils.ts` and `src/lib/bookmarks/url-normalizer.ts`, and share-import them across `BookmarkManager` and `merge.ts`.
- **Folder Creation Serialization Mutex (`folderCreationLock`)**:
  - `ensureFolderPath()` must serialize lookups and creations via `folderCreationLock.acquire()` to prevent duplicate folder tree nodes when concurrent AI tasks recommend identical paths.

### 5. Bookmark Creation/Deletion Lifecycle & Race Condition Defenses
- **Create & Immediate Delete Defense**:
  - Immediately before executing `db.bookmarks.add` after async IPC/folder lookups in `onCreated`, verify the browser node is still valid using `browser.bookmarks.get(id)`. Abort if already deleted to prevent zombie DB records.
- **Preventing Orphan Data in Async Queues**:
  - At archive save time, verify the parent bookmark record exists in `db.bookmarks`.
  - When deleting a bookmark (`removeBookmark`, `onRemoved`), immediately cancel pending/running AI jobs (`cancelBookmarkAi`) and delete local archive records.
- **Tombstone Invalidation on Re-registration**:
  - Re-registering a previously deleted URL must bump `modifiedAt` and purge existing tombstones (`removeTombstone`) so the new bookmark is not deleted by 3-way merge.

### 6. Cloud Sync Engine Safety & Concurrency Guards
- **Sync Mutex & Listener Muting**:
  - Acquire `syncInProgress` mutex before updating `db.syncState` to `syncing`.
  - Activate `BookmarkManager.setSyncMuted(true)` during sync operations (cleared in `finally`) to block local change listeners from triggering recursive sync loops.
- **Optimistic Concurrency & Server Modification Revalidation**:
  - Read `cloudBaseModified` before merge, and recheck `currentModified` immediately before writing back to cloud storage. Abort write on concurrent remote modification (`isConcurrentWrite`).
- **Fail-Safe Cloud Overwrite Guard**:
  - If `bookmarksToApply.length > 0` but local dataset yields 0 bookmarks, abort cloud upload immediately to prevent wiping remote backups.
- **Fill-Gap Auto-Resolution**:
  - When local and cloud records share URL/title but one side has completely empty metadata (uncategorized), automatically adopt the filled side without raising conflict modals.
- **Cloud Payload Stripping**:
  - Strip local-only fields (`id`, `aiStatus`, `syncedAt`, `crossRootReview`) before uploading cloud JSON.
- **Credential Encryption**:
  - Sensitive sync credentials (WebDAV passwords, OAuth tokens) stored in settings must be encrypted via `encryptCredential()` using AES-GCM 256-bit with random 12-byte IV.

### 7. Bookmark Reset / Wipe Restrictions & Mandatory User Consent Gate (CRITICAL)
- **Mandatory User Consent Gate for Destructive Reset/Wipe**:
  - Any feature, UI control, or routine capable of resetting, clearing, or mass-deleting already registered bookmarks (e.g., full catalog reset, bulk purge) **MUST strictly require explicit, unambiguous user confirmation and consent** (e.g., high-friction confirmation modal with clear warnings of irreversible data loss).
  - **NEVER** execute silent, automatic, implicit, or unattended bookmark resets in production builds under any circumstances.
- **Strict Prohibition of Implicit Wipes in Features, Migrations & Disconnects**:
  - Feature implementations, background jobs, schema migrations, sync error recovery, and account disconnections (`SyncSettings.disconnect`) must NEVER wipe, purge, or recreate local bookmarks as a side effect. Only transient state (sync tokens, adapter caches, connection status) may be reset.
  - Sync conflicts, unlinked folders, or network failures must always fail safely or stage changes non-destructively without degrading or purging existing user bookmarks.
- **Strict Isolation of Unattended Reset Logic to Test Environments**:
  - Automated/unattended database wiping, mock bookmark resetting, or fixture teardowns must strictly reside in test files (`*.test.ts`) or be strictly gated behind test-only helpers (`_reset*ForTest()`, `import.meta.env.MODE === 'test'`).
  - No developer shortcut, experimental bypass, or hidden debug command capable of wiping registered bookmarks without user consent may ever be committed to production entrypoints (`src/entrypoints/*`) or user-facing components.

---

## 8. Cloud Archive Reset-Wipe & Single-Flight Invariants

### Deletion Intent Confirmation Gate (Invariant #1 & #2)
- **CRITICAL**: Cloud archive files (`archives/<syncId>.html`) and index entries in `index.json` MUST NEVER be deleted purely because the bookmark record is missing in the local database.
- **Tombstone Requirement**: Cloud archive deletion is permitted ONLY when explicit deletion intent is confirmed via a registered tombstone (`deletedSyncIds.has(entry.syncId)`).
- **Why**: Prevents a clean installation or newly connected profile from wiping the user's entire remote cloud archive library before bookmark sync finishes.

### Single-Flight Upload Claim (`claimArchiveUpload`)
- `claimArchiveUpload()` must only block when an active upload is currently running (`status === 'uploading'`). Completed (`uploaded`), failed (`error`), or pending claims must not block sequential upload sweeps.

### Archive Restore & Settings Catch-Up
- **Restore Upsert ID Preservation**: When restoring archives from cloud storage into `db.archivedPages`, preserve existing `localArchive.id` to perform in-place updates rather than creating duplicate rows.
- **Toggle Catch-Up Trigger**: Enabling archive sync (`setArchiveSyncEnabled(true)`) must immediately fire `syncPendingArchives()` in the background.

---

## 9. AI Analysis Queue, LLM Safety & Content Extraction

### 1. Unified Queue & Worker Concurrency
- **Persistent Job Enqueueing**: All AI categorization and summarization tasks must be enqueued via `enqueueAiJob()` / `enqueueAiJobs()` in `src/lib/ai/ai-queue.ts`. Never invoke `analyzeContent()` directly from UI components.
- **Compound Deduplication Key**: Deduplicate incoming jobs against `db.aiJobs` using the composite index `[bookmarkId+kind]`. Active jobs (`queued` or `running`) must be rejected (`reason: 'duplicate'`).
- **Synchronous Claim & Worker Pool**: Worker concurrency is bounded by `getEffectiveConcurrency()` (range 1–5, default 2–3). The dispatcher synchronously registers job IDs in memory before async dispatch to prevent duplicate executions.
- **Service Worker Restart Recovery (`initAiQueue`)**:
  - On background startup, reset jobs stuck in `running` back to `queued` (or `error` if `attempts >= MAX_AI_RETRIES`).
  - Sweep orphan bookmarks having `aiStatus: 'running' | 'pending'` without matching jobs back to `'none'`.

### 2. Error Classification & Dead-Letter Handling
- **Transient vs Permanent Errors**:
  - Transient errors retry up to `MAX_AI_RETRIES` (3) with exponential backoff ($2s \to 8s \to 32s$). Every attempt is logged in `job.retryHistory`.
  - Permanent errors (`isPermanentAiError`: `TokenSoupError`, HTTP 400/401/403/404, invalid API key, quota exceeded, model not found, AI unconfigured) must immediately fail to `status: 'error'` with `retryable: false`.

### 3. Prompt Invariants & Output Sanitization
- **Language Conformity**: Summary, category, tags, and suggested new folder paths must match `detectBrowserLanguage(targetLanguage)`. Existing folder structures (`suggestedFolderId != null`) remain untranslated.
- **Korean Summary Rule**: Must end with a noun phrase (명사형 종결, e.g., `...플랫폼`, `...가이드`), strictly omitting polite narrative endings (`~입니다`, `~합니다`) and website title repetitions.
- **Single-Noun Sanitization**: Categories and folder segments must be single concise nouns sanitized via `sanitizeCategory()` and `sanitizeFolderName()`, stripping conjunctions (`and`, `or`, `및`, `와`, `과`, `&`, `+`, `/`).
- **Local LLM Safety**: Endpoints matching `isLocalEndpoint` receive a safe token budget ($\ge 2048$ via `getSafeMaxTokens`). Output matching `TOKEN_SOUP_RE` must be rejected via `TokenSoupError`.
- **Reasoning / CoT Stripping**: `<think>...</think>` and `<thought>...</thought>` blocks must be stripped before JSON parsing.
- **Cross-Root Folder Move Staging**: When AI suggests moving a bookmark across system root folders (e.g., `Bookmarks bar` $\to$ `Other bookmarks`), do NOT execute the move automatically. Stage the recommendation in `crossRootReview` on the bookmark for explicit user approval.

### 4. Archiving & Multi-Tier Content Extraction
- **4-Tier Fallback Extraction Hierarchy**:
  1. Live Tab IPC (`EXTRACT_TEXT` to `content.ts`) with 1500ms timeout.
  2. Direct Network Fetch (`fetchHtmlWithCharset()` + SW-safe pure string parsing via `extractPagePayloadFromHtml()`).
  3. Offline Archive Fallback (`db.archivedPages` + `decompressArchiveHtml()`).
  4. Metadata Fallback (`title`, `url`, `metaDescription` or sentinel `NO_BODY_TEXT`).
- **Archive Sanitization**:
  - Block tracking/ad domains matching `BLOCKED_DOMAINS` in `src/lib/archive/archive-sanitizer.ts`.
  - Strip `<script>`, `<noscript>`, inline event handlers (`on*`), and `javascript:` URLs.
  - Inline CSS, fonts, and images with concurrency limit 4 (`ConcurrencyLimiter`) and asset URL deduplication.
  - Leave video/audio media stream tags as external URLs.
- **Local Preservation Invariant**: Local archive records in `db.archivedPages` must NEVER be deleted due to cloud upload or storage quota errors.


