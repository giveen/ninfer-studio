import type { EngineProfile } from './types';

export interface Preset {
  id: string;
  name: string;
  description: string;
  profile: EngineProfile;
}

/** Blank slate: only port. Everything else uses engine executable defaults. */
export const BLANK_PROFILE: EngineProfile = { port: 8080 };

export const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Executable defaults: bf16 KV, no speculation, C=1, 8k context.',
    profile: { port: 8080 },
  },
  {
    id: 'long-context-mtp3',
    name: 'Long context MTP3',
    description:
      '240k context, FP8 KV, 2 lanes, 2 device + 8 host state slots, 8 GiB host KV, MTP3 with optimized head, vision, thinking preserved. The published RTX 5090 profile.',
    profile: {
      port: 8080,
      maxContext: 240_000,
      kvCapacity: 240_000,
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 2,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
      vision: true,
    },
  },
  {
    id: 'chat-mtp3',
    name: 'Chat MTP3',
    description: 'Balanced chat: 32k context, FP8 KV, auto KV pool, MTP3, thinking on.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
    },
  },
  {
    id: 'vision-mtp3',
    name: 'Vision multimodal',
    description: 'Image/video input enabled (Vision weights resident) with MTP3 text decode.',
    profile: {
      port: 8080,
      maxContext: 81_920,
      kvCapacity: 'auto',
      maxConcurrency: 1,
      kvDtype: 'fp8',
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      vision: true,
      mediaCacheMib: 1024,
      mediaLiveMib: 2048,
    },
  },
  {
    id: 'max-concurrency',
    name: 'Max concurrency (C=8)',
    description:
      'Eight active lanes with matching device state slots for maximum aggregate decode throughput on nvfp4 artifacts.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 8,
      deviceStateSlots: 8,
      hostStateSlots: 16,
      hostKvMib: 16_384,
      kvDtype: 'fp8',
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
    },
  },
  {
    id: 'dflash-35b',
    name: '35B-A3B DFlash',
    description: 'DFlash speculative backend (1..15 drafts, 7 recommended) for Qwen3.6-35B-A3B.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      spec: 'dflash',
      draftTokens: 7,
      lmHeadDraft: true,
    },
  },
  {
    id: 'dflash2-38',
    name: '3.8-27B DFlash2',
    description:
      'DFlash2 (1..15 drafts, 7 recommended) for Qwen3.8-27B artifacts that carry the companion weights.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      spec: 'dflash2',
      draftTokens: 7,
      lmHeadDraft: true,
    },
  },
];

export const KV_DTYPES = ['bf16', 'int8', 'fp8', 'nvfp4', 'k8v4'] as const;

export const KV_DTYPE_OPTIONS = [
  {
    value: 'bf16',
    label: 'bf16',
    hint: 'Default 16-bit KV. Highest precision, 2× the memory of the 8-bit formats — best when VRAM is plentiful.',
  },
  {
    value: 'int8',
    label: 'int8',
    hint: '8-bit KV. Halves pool memory vs bf16 for a small precision cost.',
  },
  {
    value: 'fp8',
    label: 'fp8',
    hint: 'FP8 E4M3 with row-256 scaling. Halves pool memory vs bf16 — the workhorse for long-context pools (the published 5090 profile uses it).',
  },
  {
    value: 'nvfp4',
    label: 'nvfp4',
    hint: 'NVFP4 (group-16) KV. ~4× the capacity per GiB of bf16 at some precision cost — for the largest pools.',
  },
  {
    value: 'k8v4',
    label: 'k8v4',
    hint: 'Asymmetric: FP8 keys + NVFP4 values. Keeps the precision-sensitive key path at 8-bit while compressing values — nvfp4 capacity with quality closer to fp8.',
  },
] as const;
export const SPEC_BACKENDS = [
  { id: '', name: 'off' },
  { id: 'mtp', name: 'MTP' },
  { id: 'dflash', name: 'DFlash' },
  { id: 'dflash2', name: 'DFlash2' },
] as const;

export const SPEC_BACKEND_OPTIONS = [
  {
    id: '',
    name: 'off',
    hint: 'No speculative backend — plain autoregressive decode. Simplest, no draft overhead.',
  },
  {
    id: 'mtp',
    name: 'MTP',
    hint: 'The model’s native MTP head, 1–5 draft tokens. For artifacts carrying MTP weights (the published 5090 profile uses 3 drafts).',
  },
  {
    id: 'dflash',
    name: 'DFlash',
    hint: 'External DFlash draft model, 1–15 draft tokens (7 recommended). For the Qwen3.6-35B-A3B artifact.',
  },
  {
    id: 'dflash2',
    name: 'DFlash2',
    hint: 'DFlash2 companion head, 1–15 draft tokens (7 recommended). For 3.8-27B artifacts with DFlash2 companion weights.',
  },
] as const;
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'critical', 'off'] as const;
