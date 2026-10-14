// READ-ONLY: query Langfuse for sally's failing turn at 2026-10-13T07:23 UTC.
const PUB=process.env.LANGFUSE_PUBLIC_KEY, SEC=process.env.LANGFUSE_SECRET_KEY;
const HOSTS=[process.env.LANGFUSE_HOST, process.env.LANGFUSE_BASEURL, 'https://us.cloud.langfuse.com','https://cloud.langfuse.com'].filter(Boolean);
const auth='Basic '+Buffer.from(`${PUB}:${SEC}`).toString('base64');
const SESSION='amiko:cmmkiu6cq0000lb04cupxbn3y';
let HOST=null;
for (const h of HOSTS) {
  try { const r=await fetch(`${h}/api/public/traces?limit=1`,{headers:{Authorization:auth}}); if(r.ok){HOST=h;break;} console.log('try',h,r.status);}catch(e){console.log('try',h,'ERR',e.message);}
}
if(!HOST){console.log('no working host');process.exit(1);}
console.log('HOST:',HOST,'\n');

// traces in the window for this session
const from='2026-10-13T07:20:00Z', to='2026-10-13T07:26:00Z';
const tr=await (await fetch(`${HOST}/api/public/traces?sessionId=${encodeURIComponent(SESSION)}&fromTimestamp=${from}&toTimestamp=${to}&limit=20`,{headers:{Authorization:auth}})).json();
console.log('traces found:', tr.data?.length ?? 0);
for (const t of (tr.data||[])) {
  console.log(`\n--- trace ${t.id} | ${t.timestamp} | name=${t.name} | level=${t.level} ---`);
  if(t.statusMessage) console.log('  statusMessage:', String(t.statusMessage).slice(0,300));
  // observations for this trace
  const ob=await (await fetch(`${HOST}/api/public/observations?traceId=${t.id}&limit=50`,{headers:{Authorization:auth}})).json();
  for (const o of (ob.data||[])) {
    if(o.level==='ERROR' || o.type==='GENERATION'){
      console.log(`  [${o.type}] ${o.name} level=${o.level} model=${o.model}`);
      if(o.statusMessage) console.log('     statusMessage:', String(o.statusMessage).slice(0,500));
      if(o.level==='ERROR' && o.output) console.log('     output:', JSON.stringify(o.output).slice(0,800));
    }
  }
}
