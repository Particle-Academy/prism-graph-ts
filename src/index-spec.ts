import { digest } from './digest.js';
import { InvalidArgumentError } from './errors.js';

/**
 * The embedder an index is pinned to. Vectors from a different provider,
 * model, dimension count or recipe are refused, never mixed into the index.
 */
export class IndexSpec {
  constructor(
    readonly name: string,
    readonly provider: string,
    readonly model: string,
    readonly dimensions: number,
    readonly recipe = 'raw@1',
  ) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(name)) {
      throw new InvalidArgumentError('Index names are 1-100 of A-Z a-z 0-9 _ . : -');
    }
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536) {
      throw new InvalidArgumentError('Dimensions must be between 1 and 65536.');
    }
    Object.freeze(this);
  }

  /** Stable identity of the embedder, identical to the PHP reference's fingerprint(). */
  fingerprint(): string {
    return digest('prism-graph/index@1', [this.provider, this.model, this.dimensions, this.recipe]);
  }
}
