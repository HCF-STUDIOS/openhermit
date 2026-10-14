// READ-ONLY: full detail of sally's 07:22 generation + all observations on the trace.
const PUB=process.env.LANGFUSE_PUBLIC_KEY, SEC=process.env.LANGFUSE_SECRET_KEY;
const HOST='https://us.cloud.langfuse.com';
const auth='Basic '+Buffer.from(`${PUB}:${SEC}`).toString('base64');
const TRACE='774ae426-305d-424e-883a-5f4064081371';
const g=async(u)=>(await fetch(HOST+u,{headers:{Authorization:auth}})).json();

const ob=await g(`/api/public/observations?traceId=${TRACE}&limit=50`);
console.log('observations on trace:', ob.data?.length);
for (const o of (ob.data||[])) {
  console.log(`\n=== [${o.type}] ${o.name} | level=${o.level} | model=${o.model} | ${o.startTime} ===`);
  console.log('  statusMessage:', o.statusMessage ?? '(none)');
  console.log('  usage:', JSON.stringify(o.usage||o.usageDetails||{}));
  if(o.metadata) console.log('  metadata:', JSON.stringify(o.metadata).slice(0,600));
  // output is where an error body usually lands
  const out = o.output;
  console.log('  output:', out==null?'(null)':JSON.stringify(out).slice(0,1500));
}
