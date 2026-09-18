import pg from 'pg';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const v = JSON.parse(input);
  const url = v.DIRECT_URL || v.DATABASE_URL;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query("select value from meta where key = 'gateway.config'");
  await client.end();
  if (!rows.length) {
    console.log('NO_ROW');
    return;
  }
  const cfg = JSON.parse(rows[0].value);
  console.log('KEYS: ' + Object.keys(cfg).join(', '));
  console.log('defaultModel: ' + JSON.stringify(cfg.defaultModel ?? null));
  console.log('FULL:');
  console.log(JSON.stringify(cfg, null, 2));
});
