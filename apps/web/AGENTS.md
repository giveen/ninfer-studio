# Web Subsystem Agent Instructions (`apps/web`)

These instructions apply to all frontend TypeScript and React development under `apps/web/`.

## Stack & Environment

- **Framework**: React 19, Vite 8, TypeScript 5.7+
- **Styling**: Tailwind CSS v4, Lucide React icons
- **State & UI**: Radix UI primitives, CodeMirror 6 text editor, React Markdown
- **Testing**: Vitest (`pnpm --filter @ninfier/web test`), Playwright E2E (`pnpm --filter @ninfier/web test:e2e`)

## Coding & Architecture Guidelines

1. **Streaming Chat Performance**:
   - Streaming LLM token updates occur at high frequency. Ensure token buffers and chat message states update cleanly without triggering unnecessary full-tree re-renders.
   - Decouple heavy syntax highlighting (CodeMirror / highlight.js) and Markdown rendering from active input controls.

2. **Component & State Isolation**:
   - Keep transient component state (input drafts, UI toggles) local to the component.
   - Do not mutate global arrays or shared objects directly; use immutable state update patterns.

3. **Tauri IPC Integration**:
   - Wrap `@tauri-apps/api` calls in explicit helper functions with try/catch error boundaries.
   - Handle web/desktop fallback gracefully when running in standard browser dev mode (`pnpm dev:web`).

## Local Validation

Run targeted validation commands prior to committing UI changes:

```bash
# Run unit tests
pnpm --filter @ninfier/web test

# Run TypeScript type check
pnpm --filter @ninfier/web typecheck
```
