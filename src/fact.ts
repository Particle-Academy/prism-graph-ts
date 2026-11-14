import type { FactStatus } from './trust.js';

/**
 * A subject-predicate-object statement, bi-temporal:
 *  - VALID time [validFrom, validTo): when it held in the world;
 *  - RECORDED time [recordedAt, expiredAt): when the memory held it.
 *
 * The app supplies id, subject, predicate, object, evidence and valid times.
 * The store fills status, recordedAt, expiredAt and supersededBy; a writer
 * that sets any of them is refused.
 */
export interface Fact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** Chunk ids this fact rests on. */
  readonly evidence: readonly string[];
  readonly validFrom: string;
  readonly validTo?: string | null;
  readonly supersededBy?: string | null;
  readonly status?: FactStatus | null;
  readonly recordedAt?: string | null;
  readonly expiredAt?: string | null;
}

/** What an erasure removed, as counts that can be shown as evidence. */
export interface EraseReport {
  readonly sourceFound: boolean;
  readonly chunks: number;
  readonly evidenceLinks: number;
  readonly factsErased: number;
  readonly factsKept: number;
  readonly vectors: number;
  /** The erased chunk ids (vectors are removed by these). */
  readonly chunkIds: readonly string[];
}

export interface IngestReport {
  readonly source: string;
  readonly sha256: string;
  readonly recipe: string;
  readonly chunks: number;
  readonly stored: number;
  /** Chunks of this source retired after the ingest: text it no longer contains. */
  readonly retired: number;
}
