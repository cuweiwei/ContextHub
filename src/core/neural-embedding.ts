import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ContextItem } from './types.js';

export const NEURAL_MODEL = 'intfloat/multilingual-e5-small';
export const NEURAL_DIMENSIONS = 384;

export interface NeuralEmbeddingAdapter {
  readonly model: typeof NEURAL_MODEL;
  readonly dimensions: 384;
  embedQuery(value: string): Promise<Float32Array>;
  embedItem(item: Pick<ContextItem, 'title' | 'content' | 'tags' | 'entities'>): Promise<Float32Array>;
}

/** Runtime intentionally refuses network downloads. A benchmark image must
 * provide the pinned model files and checksum before this adapter can run. */
export async function createNeuralEmbeddingAdapter(opts: { modelDir: string; checksum: string }): Promise<NeuralEmbeddingAdapter> {
  const manifest = await fs.readFile(`${opts.modelDir}/SHA256SUMS`, 'utf8').catch(() => '');
  if (!manifest || !manifest.includes(opts.checksum)) throw new Error('neural model checksum is not present in the local benchmark image');
  const digest = createHash('sha256').update(manifest).digest('hex');
  if (!digest) throw new Error('unable to verify neural model manifest');
  const unavailable = async () => { throw new Error('neural runtime is benchmark-only; production activation requires the CHB-021 gate'); };
  return { model: NEURAL_MODEL, dimensions: NEURAL_DIMENSIONS, embedQuery: unavailable, embedItem: unavailable };
}

export interface NeuralActivationGate { privateRecallDelta: number; overallDelta: number; nasP95Ms: number; passed: boolean; status: 'deferred' | 'passed' | 'failed' }

export function evaluateNeuralGate(input: Omit<NeuralActivationGate, 'passed' | 'status'>): NeuralActivationGate {
  const passed = input.privateRecallDelta >= 0.05 && input.overallDelta >= -0.01 && input.nasP95Ms <= 250;
  return { ...input, passed, status: passed ? 'passed' : 'failed' };
}
