/** A refusal by the graph itself: forged ids, policy violations, pinned embedders, storage refusals. */
export class GraphError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GraphError';
  }
}

/** A malformed argument: a programming error in the caller, kept apart from GraphError on purpose. */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}
