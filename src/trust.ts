import { InvalidArgumentError } from './errors.js';

/**
 * Where a memory came from. Recorded on every source and never inferred from
 * the content: published memory-poisoning attacks (MINJA, AgentPoison) work by
 * getting ordinary content treated as trusted. Tool output in particular is
 * someone else's text and is never promoted to a fact on its own.
 */
export const Trust = {
  /** What the person said. */
  User: 'user',
  /** A document the app ingested on purpose. */
  Document: 'document',
  /** The model's own words or notes. */
  Agent: 'agent',
  /** Output of a tool call: third-party text. */
  Tool: 'tool',
  /** A sub-agent's report back to its parent. */
  Subagent: 'subagent',
  /** Something a background consolidator derived. */
  Consolidator: 'consolidator',
  /** Harness or scheduler bookkeeping. */
  System: 'system',
} as const;
export type Trust = (typeof Trust)[keyof typeof Trust];

const TRUSTS = new Set<string>(Object.values(Trust));

export function isTrust(value: string): value is Trust {
  return TRUSTS.has(value);
}

/**
 * Who wrote a memory and how far to trust it. Bound by the CALLER (the app or
 * an adapter that knows the session), never taken from a model's arguments.
 */
export class Origin {
  constructor(readonly trust: Trust, readonly writer: string) {
    if (!isTrust(trust)) {
      throw new InvalidArgumentError(`Unknown trust class [${String(trust)}].`);
    }
    if (!/^[A-Za-z0-9_.:@/-]{1,191}$/.test(writer)) {
      throw new InvalidArgumentError('A writer is 1-191 of A-Z a-z 0-9 _ . : @ / -');
    }
    Object.freeze(this);
  }
}

export const FactStatus = {
  /** Held as true; returned by default. */
  Accepted: 'accepted',
  /** Derived from evidence the policy does not trust alone; waits for the app. */
  Proposed: 'proposed',
  /** The agent's own conclusion; returned only when asked for, and labelled. */
  Belief: 'belief',
} as const;
export type FactStatus = (typeof FactStatus)[keyof typeof FactStatus];

/** Decides the status of a new fact from the trust of the evidence it cites. */
export interface AcceptancePolicy {
  decide(evidence: readonly Trust[]): FactStatus;
}

/**
 * Accepted only when EVERY piece of evidence is what a person said or a
 * document the app chose to ingest. Evidence that is only the agent's own
 * words makes a belief. Anything else is a proposal the app must accept.
 * Every-not-any: one trusted chunk beside an injected tool result must not
 * launder the injection into a fact.
 */
export class DefaultAcceptancePolicy implements AcceptancePolicy {
  decide(evidence: readonly Trust[]): FactStatus {
    const trusted = (t: Trust): boolean => t === Trust.User || t === Trust.Document;
    if (evidence.length > 0 && evidence.every(trusted)) {
      return FactStatus.Accepted;
    }
    if (evidence.length > 0 && evidence.every((t) => t === Trust.Agent)) {
      return FactStatus.Belief;
    }

    return FactStatus.Proposed;
  }
}
