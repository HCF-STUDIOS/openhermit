// READ-ONLY: ask the billing AUTHORITY whether Nicky's owner is depleted right now.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const u = (await c.query(`select id, privy_did, email, credits_cached_balance, credits_cached_at from amiko2.users where id=$1`,['cmv65743000f407l2rfrkl3mc'])).rows[0];
await c.end();
console.log('owner:', JSON.stringify(u));

const base = (process.env.API_SERVICE_URL || process.env.NEXT_PUBLIC_API_SERVICE_URL || '').trim().replace(/\/$/,'');
const tok = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
console.log('api-service url set:', !!base, '| token set:', !!tok);
if (!base || !tok) { console.log('MISSING env → gate would return "unknown" → fail OPEN (dispatch).'); process.exit(0); }

const r = await fetch(`${base}/api/internal/billing/credit-status`, {
  headers: { Authorization: `Bearer ${tok}`, 'x-service-user-id': u.privy_did, 'x-source-service': 'amiko-chat' },
  signal: AbortSignal.timeout(5000),
});
console.log('HTTP', r.status);
const body = await r.text();
console.log('body:', body);
