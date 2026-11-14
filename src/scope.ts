import { digest } from './digest.js';
import { InvalidArgumentError } from './errors.js';

const ID = /^[A-Za-z0-9_.:@/-]{1,191}$/;

/**
 * Where a memory lives and who can read it. Every read and write goes through
 * one; there is no unscoped query.
 *
 * Levels nest: tenant > owner > agent > thread. An agent needs an owner and a
 * thread needs an agent, so no row can be visible across owners except a
 * tenant-wide one written deliberately at tenant level.
 *
 * A reader at (t, o, a, th) sees rows whose tenant is t and whose every
 * narrower level is either unset (shared upward) or exactly its own.
 */
export class Scope {
  readonly tenant: string;
  readonly owner: string | null;
  readonly agent: string | null;
  readonly thread: string | null;

  constructor(tenant: string, owner: string | null = null, agent: string | null = null, thread: string | null = null) {
    for (const [level, value] of [['tenant', tenant], ['owner', owner], ['agent', agent], ['thread', thread]] as const) {
      if (value !== null && (typeof value !== 'string' || !ID.test(value))) {
        throw new InvalidArgumentError(`Scope ${level} must be 1-191 of A-Z a-z 0-9 _ . : @ / -`);
      }
    }
    if (agent !== null && owner === null) {
      throw new InvalidArgumentError('An agent scope needs an owner: agent memory is always about someone.');
    }
    if (thread !== null && agent === null) {
      throw new InvalidArgumentError('A thread scope needs an agent.');
    }
    this.tenant = tenant;
    this.owner = owner;
    this.agent = agent;
    this.thread = thread;
    Object.freeze(this);
  }

  static tenant(tenant: string): Scope {
    return new Scope(tenant);
  }

  withOwner(owner: string): Scope {
    return new Scope(this.tenant, owner);
  }

  withAgent(agent: string): Scope {
    if (this.owner === null) {
      throw new InvalidArgumentError('Set the owner before the agent.');
    }

    return new Scope(this.tenant, this.owner, agent);
  }

  withThread(thread: string): Scope {
    return new Scope(this.tenant, this.owner, this.agent, thread);
  }

  level(): 'tenant' | 'owner' | 'agent' | 'thread' {
    return this.thread !== null ? 'thread' : this.agent !== null ? 'agent' : this.owner !== null ? 'owner' : 'tenant';
  }

  /** Can a reader at this scope see a row stored at `row`? */
  canSee(row: Scope): boolean {
    return row.tenant === this.tenant
      && (row.owner === null || row.owner === this.owner)
      && (row.agent === null || row.agent === this.agent)
      && (row.thread === null || row.thread === this.thread);
  }

  /** The internal id for an app-supplied key at this scope (identical to the PHP reference). */
  qualify(kind: string, key: string): string {
    return digest(`prism-graph/${kind}@1`, [this.tenant, this.owner ?? '', this.agent ?? '', this.thread ?? '', key]);
  }

  toRow(): [string, string | null, string | null, string | null] {
    return [this.tenant, this.owner, this.agent, this.thread];
  }
}
