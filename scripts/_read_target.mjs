import pg from 'pg';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const v = JSON.parse(input);
  const url = v.DIRECT_URL || v.DATABASE_URL;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('=== existing amiko/deepseek-v4.1-flash model objects (canonical target shape) ===');
  const t = await client.query(
    `select agent_id, config_json::jsonb -> 'model' as m
       from agents
      where config_json::jsonb #>> '{model,provider}' = 'amiko'
        and config_json::jsonb #>> '{model,model}' = 'deepseek/deepseek-v4.1-flash'
      limit 5`,
  );
  for (const r of t.rows) console.log(`${r.agent_id}: ${JSON.stringify(r.m)}`);

  console.log('\n=== rows my UPDATE WHERE will touch ===');
  const c = await client.query(`
    select count(*) as n
      from agents
     where config_json::jsonb #>> '{model,provider}' in ('amiko','openrouter')
       and config_json::jsonb #>> '{model,model}' in
           ('google/gemini-3-flash-preview','google/gemini-3.1-flash-lite-preview')
  `);
  console.log('total to update: ' + c.rows[0].n);

  // Show any of these that carry extra model fields (thinking/base_url/api) so we know what we'd drop.
  console.log('\n=== extra fields present among targets ===');
  const e = await client.query(`
    select
      count(*) filter (where config_json::jsonb #> '{model,thinking}' is not null) as with_thinking,
      count(*) filter (where config_json::jsonb #> '{model,base_url}' is not null) as with_base_url,
      count(*) filter (where config_json::jsonb #> '{model,api}' is not null)      as with_api
      from agents
     where config_json::jsonb #>> '{model,provider}' in ('amiko','openrouter')
       and config_json::jsonb #>> '{model,model}' in
           ('google/gemini-3-flash-preview','google/gemini-3.1-flash-lite-preview')
  `);
  console.log(JSON.stringify(e.rows[0]));

  await client.end();
});
