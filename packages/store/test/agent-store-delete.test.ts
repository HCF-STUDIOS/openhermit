import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { DbAgentStore } from '../src/impl/agent-store.js';
import { runMigrations } from '../src/impl/migrator.js';

/**
 * Placeholder for a NOT NULL column with no default, by Postgres type. Good
 * enough to satisfy constraints; the values are never read.
 */
const placeholder = (dataType: string, udtName: string): string => {
  switch (dataType) {
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
    case 'real':
    case 'double precision':
      return '0';
    case 'boolean':
      return 'false';
    case 'json':
    case 'jsonb':
      return `'{}'`;
    case 'ARRAY':
      return `'{}'::${udtName.replace(/^_/, '')}[]`;
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date':
      return 'now()';
    case 'USER-DEFINED':
      return `NULL`; // pgvector etc. — handled by the caller skipping NOT NULL-less columns
    default:
      return `'${randomUUID()}'`;
  }
};

test('DbAgentStore.delete removes the agent from every agent-scoped table', async (t) => {
  await runMigrations();
  const store = await DbAgentStore.open();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  const agentId = `test-agent-del-${randomUUID().slice(0, 8)}`;
  const bystander = `test-agent-keep-${randomUUID().slice(0, 8)}`;

  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'agent_id'
      ORDER BY table_name`,
  );
  assert.ok(tables.length > 10, 'sanity: found the agent-scoped tables');

  // Seed one row per agent-scoped table, for the doomed agent and a bystander.
  for (const { table_name: table } of tables) {
    const { rows: cols } = await pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
    }>(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND is_nullable = 'NO' AND column_default IS NULL
          AND is_generated = 'NEVER' AND column_name <> 'agent_id'`,
      [table],
    );
    for (const id of [agentId, bystander]) {
      const names = ['"agent_id"', ...cols.map((c) => `"${c.column_name}"`)];
      const values = ['$1', ...cols.map((c) => placeholder(c.data_type, c.udt_name))];
      await pool.query(
        `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${values.join(', ')})`,
        [id],
      );
    }
  }

  await store.delete(agentId);

  const leftovers: string[] = [];
  for (const { table_name: table } of tables) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE agent_id = $1`,
      [agentId],
    );
    if (rows[0]!.n > 0) leftovers.push(table);
    const { rows: kept } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE agent_id = $1`,
      [bystander],
    );
    assert.equal(kept[0]!.n, 1, `${table}: another agent's row is untouched`);
  }
  assert.deepEqual(leftovers, [], 'no agent-scoped table keeps rows of a deleted agent');

  await store.delete(bystander);
});
