import fs from 'node:fs';
import { evaluateNeuralGate } from '../src/core/neural-embedding.js';

const result = evaluateNeuralGate({ privateRecallDelta: Number(process.env.PRIVATE_RECALL_DELTA ?? '0'), overallDelta: Number(process.env.OVERALL_DELTA ?? '0'), nasP95Ms: Number(process.env.NAS_P95_MS ?? 'Infinity') });
const output = { format: 'contexthub-neural-eval/v1', model: 'intfloat/multilingual-e5-small', dimensions: 384, gate: result, activation: result.passed ? 'eligible_pending_review' : 'deferred', generated_at: new Date().toISOString() };
console.log(JSON.stringify(output, null, 2));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
