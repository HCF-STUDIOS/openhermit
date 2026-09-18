import pg from 'pg';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const v = JSON.parse(input);
  const url = v.DIRECT_URL || v.DATABASE_URL;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const dist = await client.query(`
    select
      config_json::jsonb #>> '{model,provider}' as provider,
      config_json::jsonb #>> '{model,model}'    as model,
      count(*) as n
    from agents
    where config_json is not null
    group by 1, 2
    order by n desc
  `);
  console.log('=== provider / model / count ===');
  for (const r of dist.rows) console.log(`${r.n}\t${r.provider} / ${r.model}`);

  console.log('\n=== sample model objects for the two old-default ids ===');
  for (const id of ['google/gemini-3-flash-preview', 'google/gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview']) {
    const s = await client.query(
      `select config_json::jsonb -> 'model' as m from agents where config_json::jsonb #>> '{model,model}' = $1 limit 1`,
      [id],
    );
    if (s.rows.length) console.log(`${id} -> ${JSON.stringify(s.rows[0].m)}`);
  }

  await client.end();
});
