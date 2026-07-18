// Shared telemetry exporter state. Advisory-budget, routing, and non-LLM
// state live in separate canonical files so each entry loads only its needs.

export { bufferSize, enqueue, flush, isDegraded } from '../core/telemetry.js';
export type * from '../core/telemetry.js';
