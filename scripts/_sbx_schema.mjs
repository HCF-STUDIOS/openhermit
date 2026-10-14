import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;

console.log('search_path:', (await q(`show search_path`))[0]);
console.log('\n=== tables in ALL non-system schemas ===');
const tbls = await q(`select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by table_schema, table_name`);
for (const t of tbls) console.log(`  ${t.table_schema}.${t.table_name}`);

// where does session_events live
console.log('\n=== session_events location + columns ===');
const se = await q(`select table_schema, column_name, data_type from information_schema.columns where table_name='session_events' order by ordinal_position`);
for (const x of se) console.log(`  ${x.table_schema}.session_events ${x.column_name}:${x.data_type}`);
await c.end();
