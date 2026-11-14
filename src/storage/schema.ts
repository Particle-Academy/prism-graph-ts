import { InvalidArgumentError } from '../errors.js';

/**
 * Which app-owned tables play each role. Apps create and extend these tables
 * in their own migrations; the package only reads and writes the core columns
 * it documents. Names are capped at 50 characters so derived names stay inside
 * PostgreSQL's 63-character identifier limit.
 */
export class TableMap {
  constructor(
    readonly sources = 'graph_sources',
    readonly chunks = 'graph_chunks',
    readonly facts = 'graph_facts',
    readonly evidence = 'graph_fact_evidence',
  ) {
    for (const [role, table] of Object.entries({ sources, chunks, facts, evidence })) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(table)) {
        throw new InvalidArgumentError(`Invalid table name for ${role}.`);
      }
    }
    Object.freeze(this);
  }

  /** The full-text index over chunks (an FTS5 table on SQLite). */
  fts(): string {
    return `${this.chunks}_fts`;
  }
}

/**
 * The core schema, as plain SQL for SQLite, matching the PHP reference's
 * BaseSchema. The package never creates tables at runtime: apps run these from
 * their own migration tooling, and own them afterwards.
 */
export function baseSchema(t: TableMap = new TableMap()): string[] {
  const scope = 'tenant_id VARCHAR(191) NOT NULL, owner_id VARCHAR(191), agent_id VARCHAR(191), thread_id VARCHAR(191)';

  return [
    `CREATE TABLE ${t.sources} (id CHAR(64) PRIMARY KEY, source_key VARCHAR(191) NOT NULL, ${scope},
      uri TEXT NOT NULL, sha256 CHAR(64) NOT NULL, metadata TEXT NOT NULL,
      trust VARCHAR(20) NOT NULL, writer VARCHAR(191) NOT NULL,
      occurred_at CHAR(27), recorded_at CHAR(27) NOT NULL)`,
    `CREATE INDEX ${t.sources}_scope ON ${t.sources} (tenant_id, owner_id, agent_id, thread_id)`,
    // seq is the explicit integer key the full-text index joins on: an implicit
    // rowid is not guaranteed stable across VACUUM.
    `CREATE TABLE ${t.chunks} (seq INTEGER PRIMARY KEY, id CHAR(64) NOT NULL UNIQUE, source_id CHAR(64) NOT NULL REFERENCES ${t.sources} (id),
      text TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL,
      line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, heading_path TEXT NOT NULL,
      recipe VARCHAR(191) NOT NULL, retired_at CHAR(27))`,
    `CREATE INDEX ${t.chunks}_source ON ${t.chunks} (source_id, byte_start)`,
    `CREATE TABLE ${t.facts} (id CHAR(64) PRIMARY KEY, fact_key VARCHAR(191) NOT NULL, ${scope},
      subject VARCHAR(191) NOT NULL, predicate VARCHAR(191) NOT NULL, object TEXT NOT NULL,
      status VARCHAR(20) NOT NULL, valid_from CHAR(27) NOT NULL, valid_to CHAR(27),
      superseded_by VARCHAR(191), recorded_at CHAR(27) NOT NULL, expired_at CHAR(27))`,
    `CREATE INDEX ${t.facts}_subject ON ${t.facts} (tenant_id, subject, valid_to)`,
    `CREATE TABLE ${t.evidence} (fact_id CHAR(64) NOT NULL REFERENCES ${t.facts} (id),
      chunk_id CHAR(64) NOT NULL REFERENCES ${t.chunks} (id), PRIMARY KEY (fact_id, chunk_id))`,
    `CREATE INDEX ${t.evidence}_chunk ON ${t.evidence} (chunk_id)`,
    ...fullTextSchema(t),
  ];
}

/** External-content FTS5 kept in step by triggers; the text lives once, in the chunks table. */
export function fullTextSchema(t: TableMap = new TableMap()): string[] {
  const fts = t.fts();

  return [
    `CREATE VIRTUAL TABLE ${fts} USING fts5(text, content='${t.chunks}', content_rowid='seq', tokenize='unicode61')`,
    `CREATE TRIGGER ${t.chunks}_ai AFTER INSERT ON ${t.chunks} BEGIN
      INSERT INTO ${fts} (rowid, text) VALUES (new.seq, new.text); END`,
    `CREATE TRIGGER ${t.chunks}_ad AFTER DELETE ON ${t.chunks} BEGIN
      INSERT INTO ${fts} (${fts}, rowid, text) VALUES ('delete', old.seq, old.text); END`,
    `CREATE TRIGGER ${t.chunks}_au AFTER UPDATE OF text ON ${t.chunks} BEGIN
      INSERT INTO ${fts} (${fts}, rowid, text) VALUES ('delete', old.seq, old.text);
      INSERT INTO ${fts} (rowid, text) VALUES (new.seq, new.text); END`,
  ];
}

/**
 * Restore the full-text index after a migration that rebuilt the chunks table
 * (which drops its triggers), and rebuild it from the stored chunks. Safe to
 * run at any time.
 */
export function repairFullTextSchema(t: TableMap = new TableMap()): string[] {
  const fts = t.fts();
  const [virtual, insert, del, update] = fullTextSchema(t);

  return [
    virtual!.replace('CREATE VIRTUAL TABLE', 'CREATE VIRTUAL TABLE IF NOT EXISTS'),
    `DROP TRIGGER IF EXISTS ${t.chunks}_ai`,
    `DROP TRIGGER IF EXISTS ${t.chunks}_ad`,
    `DROP TRIGGER IF EXISTS ${t.chunks}_au`,
    insert!,
    del!,
    update!,
    `INSERT INTO ${fts} (${fts}) VALUES ('rebuild')`,
  ];
}

/** The optional vector tables (exact cosine search over packed float32). */
export function vectorSchema(indexes = 'graph_vector_indexes', vectors = 'graph_vectors'): string[] {
  return [
    `CREATE TABLE ${indexes} (name VARCHAR(100) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, provider VARCHAR(100) NOT NULL,
      model VARCHAR(191) NOT NULL, dimensions INTEGER NOT NULL, recipe VARCHAR(191) NOT NULL)`,
    `CREATE TABLE ${vectors} (index_name VARCHAR(100) NOT NULL REFERENCES ${indexes} (name), chunk_id CHAR(64) NOT NULL,
      vector BLOB NOT NULL, PRIMARY KEY (index_name, chunk_id))`,
  ];
}
