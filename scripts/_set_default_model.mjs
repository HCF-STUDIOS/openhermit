import pg from 'pg';

const NEW_DEFAULT = { provider: 'amiko', model: 'deepseek/deepseek-v4.1-flash', max_tokens: 8192 };

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const v = JSON.parse(input);
  const url = v.DIRECT_URL || v.DATABASE_URL;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("select value from meta where key = 'gateway.config' for update");
    if (!rows.length) throw new Error('gateway.config meta row not found');
    const cfg = JSON.parse(rows[0].value);
    cfg.defaultModel = NEW_DEFAULT;
    await client.query("update meta set value = $1 where key = 'gateway.config'", [JSON.stringify(cfg)]);
    await client.query('COMMIT');
    console.log('OK: gateway.config.defaultModel set to ' + JSON.stringify(NEW_DEFAULT));
    // read-back
    const { rows: r2 } = await client.query("select value from meta where key = 'gateway.config'");
    console.log('read-back defaultModel: ' + JSON.stringify(JSON.parse(r2[0].value).defaultModel));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK: ' + e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
});
