import { digest } from './digest.js';
import type { Trust } from './trust.js';

/**
 * One verbatim slice of a source: the text is exactly the source's UTF-8
 * bytes in [byteStart, byteEnd). Nothing derived ever replaces it.
 */
export interface Chunk {
  readonly id: string;
  /** The scope-qualified internal source id. */
  readonly sourceId: string;
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly headingPath: readonly string[];
  readonly recipe: string;
  /** Set when the source no longer contains this text: it leaves search but stays readable by id. */
  readonly retiredAt?: string | null;
  /** Filled on read: the app's own key for the source. */
  readonly sourceKey?: string | null;
  /** Filled on read: the trust class the source was written with. */
  readonly trust?: Trust | null;
}

/** Content-addressed chunk id, identical to the PHP reference's Chunk::idFor(). */
export function chunkId(recipe: string, sourceId: string, byteStart: number, byteEnd: number, text: string | Uint8Array): string {
  return digest('prism-graph/chunk@1', [recipe, sourceId, byteStart, byteEnd, text]);
}

export interface Chunker {
  recipe(): string;
  chunk(sourceId: string, text: string): Chunk[];
}
