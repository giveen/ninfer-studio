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
      '240k context, FP8 KV, 2 lanes, 2 device + 8 host state slots, 8 GiB host KV, MTP3 with optimized head, vision, thinking preserved. Fits the 3.6-27B (~18.2 GiB loaded) and the pre-repack 3.8 gw-int (19.0 GiB loaded, ~3.3 GiB free — the published RTX 5090 run). Fresh 3.8 gw-int downloads (19.0 GiB file, ~21.3 loaded) overflow at 240k fp8 — use 192k there, or k8v4 to keep 320k.',
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
  {
    id: 'ultra-context-k8v4',
    name: 'Ultra context 320k (k8v4)',
    description:
      'RTX 5090 (32 GB), gw-int artifacts: 320k context via k8v4 KV (FP8 keys, NVFP4 values — 1.33× fp8 density). Local 3.8 gw-int (loads 19.0 GiB) → ~28.7 GiB total, ~2.5 GiB free; 3.6-27B (~18.2 GiB) is comfier. Fresh 3.8 downloads (19.0 GiB file → ~21.3 loaded) should drop to 256k. Watch long-range recall (4-bit V).',
    profile: {
      port: 8080,
      maxContext: 320_000,
      kvCapacity: 320_000,
      maxConcurrency: 2,
      kvDtype: 'k8v4',
      deviceStateSlots: 2,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'max-fidelity-bf16',
    name: 'Max fidelity 128k (bf16 KV)',
    description:
      'RTX 5090 (32 GB), gw-int artifacts: 128k context with full-precision bf16 KV — best long-range recall. Local 3.8 gw-int (~19.0 GiB loaded) → ~29.3 GiB total, ~2.4 GiB free; 3.6-27B (~18.2) → ~3.5 free. Fresh 3.8 downloads (~21.3 loaded) must drop to 96k. nvfp4 artifacts do not fit at 128k.',
    profile: {
      port: 8080,
      maxContext: 128_000,
      kvCapacity: 128_000,
      maxConcurrency: 2,
      kvDtype: 'bf16',
      deviceStateSlots: 2,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'nvfp4-serving-c4',
    name: 'Multi-client serving C=4 (nvfp4 artifact)',
    description:
      'RTX 5090 (32 GB): the 3.8 nvfp4 artifact (loads ~20.0 GiB local / ~22.1 fresh) + fp8 KV at 160k, four concurrent lanes with queued overflow (16 pending, 60 s timeout). ~28.5-30.6 GiB total — fresh downloads are at the 1.8 GiB floor; drop to 144k if the capacity line shows under 2 GiB free. For 2-4 simultaneous clients.',
    profile: {
      port: 8080,
      maxContext: 160_000,
      kvCapacity: 160_000,
      maxConcurrency: 4,
      maxPendingRequests: 16,
      pendingTimeoutMs: 60_000,
      kvDtype: 'fp8',
      deviceStateSlots: 4,
      hostStateSlots: 16,
      hostKvMib: 16_384,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'low-latency-c1',
    name: 'Low-latency coding (C=1, 96k)',
    description:
      'RTX 5090 (32 GB): single lane, 96k fp8 context, MTP3 — fastest first token. Fits EVERY catalog artifact including the 35B-A3B MoE (~27.7 GiB total worst case). 32k default output cap; thinking preserved for agentic work.',
    profile: {
      port: 8080,
      maxContext: 96_000,
      kvCapacity: 96_000,
      maxConcurrency: 1,
      kvDtype: 'fp8',
      deviceStateSlots: 2,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      defaultMaxTokens: 32_768,
      preserveThinking: true,
    },
  },
  {
    id: 'moe-35b-a3b',
    name: '35B-A3B MoE (128k, fp8)',
    description:
      'RTX 5090 (32 GB): the Qwen3.6-35B-A3B MoE (21.2 GiB file, ~23.8 loaded — only ~3B params active per token, so decode is fast) at 128k fp8 context, 2 lanes, MTP3. ~28.8 GiB total, ~2.4 GiB free. 64k if you want comfortable headroom.',
    profile: {
      port: 8080,
      maxContext: 128_000,
      kvCapacity: 128_000,
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 2,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'experimental-nvfp4-kv-480k',
    name: 'Experimental 480k (NVFP4 KV)',
    description:
      'RTX 5090 (32 GB), single lane: 480k context via NVFP4 KV (2× fp8 density). Fits the local 3.8 gw-int (19.0 loaded → ~28.6 total) and 3.6-27B (~27.8); fresh 3.8 downloads (~21.3 loaded) must use 384k. Experimental: 4-bit K/V costs long-range recall — verify answers on long documents before trusting them.',
    profile: {
      port: 8080,
      maxContext: 480_000,
      kvCapacity: 480_000,
      maxConcurrency: 1,
      kvDtype: 'nvfp4',
      deviceStateSlots: 1,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
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
