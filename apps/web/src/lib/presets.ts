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
    id: 'coding-agent-cache-optimized',
    name: 'Coding agent (cache-optimized)',
    description:
      'Optimized for agentic coding: 200k k8v4 context, C=2, MTP3 draft, and 8 device state slots to maximize prefix cache hits during tool calls.',
    profile: {
      port: 8080,
      maxContext: 200_000,
      kvCapacity: 200_000,
      maxConcurrency: 2,
      kvDtype: 'k8v4',
      deviceStateSlots: 8,
      hostStateSlots: 8,
      maxLongAnchorsPerContinuation: 4,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      defaultMaxTokens: 32_000,
      preserveThinking: true,
    },
  },
  {
    id: 'long-context-mtp3',
    name: 'Long context MTP3',
    description:
      '160k context with FP8 KV, C=2, and MTP3 speculative decoding. Tuned for long sessions on 32 GB GPUs.',
    profile: {
      port: 8080,
      maxContext: 160_000,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 4,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
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
    description:
      'Balanced chat profile: 32k context, FP8 KV, C=2, and MTP3 speculative decoding with cache headroom for follow-up suggestions.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 6,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
    },
  },
  {
    id: 'vision-mtp3',
    name: 'Vision multimodal',
    description:
      'Vision/multimodal profile: 80k context with image and video input enabled, single lane, and MTP3 text decode.',
    profile: {
      port: 8080,
      maxContext: 81_920,
      kvCapacity: 'auto',
      maxConcurrency: 1,
      kvDtype: 'fp8',
      deviceStateSlots: 3,
      maxLongAnchorsPerContinuation: 4,
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
      'High-throughput serving: C=8 active lanes, 32k context, FP8 KV, and MTP3 draft decoding.',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 8,
      deviceStateSlots: 10,
      hostStateSlots: 16,
      hostKvMib: 16_384,
      maxLongAnchorsPerContinuation: 4,
      kvDtype: 'fp8',
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
    },
  },
  {
    id: 'dflash-35b',
    name: '35B-A3B DFlash',
    description:
      'Speculative decode for Qwen3.6-35B-A3B: 32k context, FP8 KV, and DFlash speculative backend (7 draft tokens).',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 6,
      maxLongAnchorsPerContinuation: 4,
      spec: 'dflash',
      draftTokens: 7,
      lmHeadDraft: true,
    },
  },
  {
    id: 'dflash2-38',
    name: '3.8-27B DFlash2',
    description:
      'Speculative decode for Qwen3.8-27B: 32k context, FP8 KV, and DFlash2 companion backend (7 draft tokens, requires artifact compiled with dflash2).',
    profile: {
      port: 8080,
      maxContext: 32_768,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 6,
      maxLongAnchorsPerContinuation: 4,
      spec: 'dflash2',
      draftTokens: 7,
      lmHeadDraft: true,
    },
  },
  {
    id: 'max-fidelity-bf16',
    name: 'Max fidelity 96k (bf16 KV)',
    description:
      'Full precision KV cache: 96k context with bf16 KV for maximum long-range recall within 32 GB VRAM.',
    profile: {
      port: 8080,
      maxContext: 96_000,
      kvCapacity: 'auto',
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
      'Multi-client serving: 144k FP8 context across 4 concurrent lanes with request queuing tuned for 32 GB GPUs.',
    profile: {
      port: 8080,
      maxContext: 144_000,
      kvCapacity: 'auto',
      maxConcurrency: 4,
      maxPendingRequests: 16,
      pendingTimeoutMs: 60_000,
      kvDtype: 'fp8',
      deviceStateSlots: 6,
      hostStateSlots: 16,
      hostKvMib: 16_384,
      maxLongAnchorsPerContinuation: 4,
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
      'Low-latency single-lane profile (C=1): 96k FP8 context, MTP3 speculative decode, and fast first-token latency.',
    profile: {
      port: 8080,
      maxContext: 96_000,
      kvCapacity: 96_000,
      maxConcurrency: 1,
      kvDtype: 'fp8',
      deviceStateSlots: 4,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
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
      'Tuned for Qwen3.6-35B-A3B MoE: 128k FP8 context, C=2, and MTP3 draft decoding.',
    profile: {
      port: 8080,
      maxContext: 128_000,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'fp8',
      deviceStateSlots: 3,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'ultra-context-k8v4',
    name: 'Ultra context 240k (k8v4)',
    description:
      'Ultra long context: 240k window using k8v4 (FP8 keys / NVFP4 values) with 3 device state slots.',
    profile: {
      port: 8080,
      maxContext: 240_000,
      kvCapacity: 'auto',
      maxConcurrency: 2,
      kvDtype: 'k8v4',
      deviceStateSlots: 3,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'ultra-context-nvfp4',
    name: 'Ultra context 256k (NVFP4 KV)',
    description:
      'Ultra long context: full 262k native window using NVFP4 KV cache for single-lane sequence processing.',
    profile: {
      port: 8080,
      maxContext: 262_144,
      kvCapacity: 262_144,
      maxConcurrency: 1,
      kvDtype: 'nvfp4',
      deviceStateSlots: 3,
      hostStateSlots: 8,
      hostKvMib: 8192,
      maxLongAnchorsPerContinuation: 4,
      spec: 'mtp',
      draftTokens: 3,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
  {
    id: 'community-262k-fp8',
    name: 'Community 262k fp8 (5090)',
    description:
      'Community profile: full 262k window with FP8 KV, single lane, prefill chunking, and MTP5 draft decoding.',
    profile: {
      port: 8080,
      maxContext: 262_144,
      kvCapacity: 262_144,
      maxConcurrency: 1,
      prefillChunk: 1024,
      kvDtype: 'fp8',
      deviceStateSlots: 1,
      hostStateSlots: 8,
      hostKvMib: 8192,
      spec: 'mtp',
      draftTokens: 5,
      lmHeadDraft: true,
      preserveThinking: true,
    },
  },
];

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
