# Privacy Policy for PowerBookmark

Last updated: September 8, 2026

PowerBookmark ("we", "our", or "the extension") is committed to protecting your privacy. This Privacy Policy explains how data is handled by PowerBookmark.

## 1. Core Principle: Zero Developer Servers
PowerBookmark does not operate any centralized servers, tracking services, or telemetry endpoints. We do not collect, store, sell, or monetize your personal data. All bookmark management, archiving, and analysis are performed locally on your device or transmitted directly between your browser and the third-party services you explicitly configure.

## 2. What Data We Handle and Why

### A. Bookmarks and Web History
- **Data**: Bookmarked URLs, page titles, folder paths, and timestamps.
- **Purpose**: Required to organize your bookmarks, update extension status badges, and perform two-way synchronization with your designated cloud storage accounts.
- **Storage**: Stored locally in your browser using IndexedDB (Dexie) and `chrome.storage.local`.

### B. Website Content
- **Data**: Text content and DOM structure extracted from web pages you choose to save.
- **Purpose**:
  1. Sent to your chosen AI provider (OpenAI, Anthropic, Google Gemini, or local models) solely to generate summaries, tags, and category suggestions.
  2. Inlined with styles and images to generate offline HTML snapshot archives.
- **Storage**: Archives are stored locally in your browser's IndexedDB and, if enabled by you, backed up to your personal cloud storage.

### C. Authentication Credentials
- **Data**: User-provided API keys (for AI services) and OAuth tokens / passwords (for Google Drive, OneDrive, Dropbox, WebDAV).
- **Purpose**: Authenticating requests directly with your designated cloud storage and AI providers.
- **Security**: All credentials stored locally are encrypted using AES-GCM 256-bit encryption before saving to `chrome.storage.local`.

## 3. Third-Party Services
Data leaves your device only when you explicitly connect and trigger features using the following services:
- **Cloud Storage Providers**: Google Drive, Microsoft OneDrive, Dropbox, and user-specified WebDAV servers (for syncing bookmarks and offline archives).
- **AI Providers**: OpenAI, Anthropic, Google Gemini, or custom API endpoints (for generating bookmark summaries and categories).

Each service processes data according to its own privacy policy. PowerBookmark has no access to your third-party accounts or data stored within them.

## 4. Analytics and Tracking
PowerBookmark contains:
- NO analytics SDKs (e.g., Google Analytics)
- NO advertising networks
- NO tracking pixels or fingerprinting scripts
- NO keystroke or user behavior logging

## 5. Data Retention and User Control
- **Data Ownership**: You retain full ownership of all your data.
- **Data Export**: You can export your bookmarks and offline archives at any time via the Management page.
- **Data Deletion**: Uninstalling the extension or clearing extension storage immediately and permanently removes all local databases, archives, and credentials from your device.

## 6. Contact
If you have any questions about this Privacy Policy, please open an issue on GitHub:
- Repository: https://github.com/0deep/power-bookmark
