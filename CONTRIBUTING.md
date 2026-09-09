# Contributing to PowerBookmark

Thank you for your interest in contributing to PowerBookmark! This guide will help you get started.

## Development Setup

### Prerequisites
- Node.js 22+
- npm

### Getting Started

```bash
# Clone the repository
git clone https://github.com/pow-projects/power-bookmark.git
cd power-bookmark

# Install dependencies
npm install

# Start development (Chrome)
npm run dev:chrome

# Start development (Firefox)
npm run dev:firefox
```

### Available Commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev server (default browser) |
| `npm run dev:chrome` | Start dev server (Chrome) |
| `npm run dev:firefox` | Start dev server (Firefox) |
| `npm run compile` | TypeScript type checking |
| `npm test` | Run unit tests (Vitest) |
| `npm run build:chrome` | Production build (Chrome) |
| `npm run build:firefox` | Production build (Firefox) |

## How to Contribute

### Reporting Bugs
1. Check [existing issues](https://github.com/pow-projects/power-bookmark/issues) first.
2. Use the **Bug Report** issue template.
3. Include browser, OS, and extension version.
4. Provide steps to reproduce.

### Suggesting Features
1. Open an issue using the **Feature Request** template.
2. Describe the problem your feature would solve.

### Submitting Pull Requests
1. Fork the repository.
2. Create a feature branch from `main`: `git checkout -b feat/your-feature`
3. Make your changes.
4. Ensure all checks pass:
   ```bash
   npm run compile   # Type check
   npm test          # Unit tests
   npm run build:chrome   # Build verification
   ```
5. Commit with a descriptive message following [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` — New feature
   - `fix:` — Bug fix
   - `docs:` — Documentation
   - `refactor:` — Code refactoring
   - `test:` — Adding or updating tests
6. Push and open a Pull Request.

## Code Style
- **Language**: TypeScript (strict mode)
- **Framework**: Svelte 5 + WXT
- **No hardcoded UI strings** — Use `i18n.t()` with keys in `src/locales/en.yml` and `src/locales/ko.yml`
- **No emoji icons** — Use `<Icon name="..." />` component

## License
By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
