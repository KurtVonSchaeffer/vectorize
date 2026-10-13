export type AiTask = 'upscale2x' | 'upscale4x'

interface ModelSpec {
  id: string
  license: string
  /** Approximate download size in MB. */
  sizeMb: number
  factor: number
  /** Skip upscaling when the longest side is already above this. */
  maxInput: number
}

// Swin2SR runs on multi-threaded WASM: in testing, WebGPU was no faster for this model and
// added a long first-run shader compile. Only permissively licensed models are used.
export const MODELS: Record<AiTask, ModelSpec> = {
  upscale2x: {
    id: 'Xenova/swin2SR-lightweight-x2-64',
    license: 'Apache-2.0',
    sizeMb: 8,
    factor: 2,
    maxInput: 1024,
  },
  upscale4x: {
    id: 'Xenova/swin2SR-compressed-sr-x4-48',
    license: 'Apache-2.0',
    sizeMb: 55,
    factor: 4,
    maxInput: 512,
  },
}
