// Barrel: re-exports every domain module's public API so every existing
// `from '../lib/api'` / `from './api'` import across the app keeps working
// unchanged. The real implementations live in ./api/{config,engine,models,
// chat,coder}.ts, split by domain (this file used to be 1062 lines);
// ./api/core.ts holds the shared fetch plumbing those modules build on.
export * from './api/config';
export * from './api/engine';
export * from './api/models';
export * from './api/chat';
export * from './api/coder';
