// READ-ONLY openhermit: for each messaged new twin, count events. 0 events = Nicky-class failure.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p)=>(await c.query(s,p)).rows;

const CAND = [
 ["cmv3586dx000107l1gqjj188e","昶皓",7],["cmv3fw6ko000507l8v9maqxbo","13887890043",6],
 ["cmv3oqifp000b07kxmrq2seuc","kaka",4],["cmv3s1iv9000007kzqz44xwuw","DANNI",3],
 ["cmv3s4sri001607i6v7rbx6es","橄榄枝",17],["cmv3tdk5z000b07lceaq0ypdi","ha ha",1],
 ["cmv3uo36h000007jrj1tmr8yi","feng ge",11],["cmv3xucop000007jykxlh5igz","刘美美",1],
 ["cmv465akm000007l5nedpujvs","勋哥",5],["cmv4sqyy3000507jmp2rr27l7","3339537554",2],
 ["cmv4x5kuf000g07rnzq1b3dj3","1687067535",9],["cmv4y1sy1000s07jv42r9fzj1","梅子",1],
 ["cmv500bkr000006l9j6vv762l","穗盈",1],["cmv50pkr9000a07l68vo3qwki","阿林",1],
 ["cmv50ymz2000406lkz9ygb8sn","茶仙子",2],["cmv51ibof000906nnnc5ma94q","老谭",1],
 ["cmv51xynf000007igl11in59n","谢润",2],["cmv53dr2r000207laqvlagqgl","442736881",1],
 ["cmv55517x000107lap04zaubk","八月秋峰",1],["cmv5je6wu000207l271ln7vrp","Koko Tai",5],
 ["cmv65sb2g000007jqrr2w3571","Nicky",5],["cmv65zcv0000307l7xmpsv8dn","碎时成金",2],
 ["cmv68594c002d07la2sbj9y0w","15662428686",1],["cmv6bawgy000707jmrtoqiu2r","幺儿",8],
];

let zero=0, ok=0;
const zeros=[];
console.log('name            msgs  OHevents  assistant  firstEvent');
for (const [id,name,msgs] of CAND) {
  const r = (await q(`select count(*)::int n, count(*) filter (where event_type='assistant')::int a, min(ts) f from openhermit.session_events where agent_id=$1`,[id]))[0];
  const flag = r.n===0 ? ' <== ZERO' : '';
  console.log(`${String(name).slice(0,14).padEnd(14)}  ${String(msgs).padStart(3)}  ${String(r.n).padStart(7)}  ${String(r.a).padStart(8)}  ${r.f||'-'}${flag}`);
  if (r.n===0){zero++; zeros.push(`${name}(${id.slice(-6)},${msgs}msg)`);} else ok++;
}
console.log(`\nSUMMARY: ${zero} ZERO-event / ${CAND.length} messaged new twins broken; ${ok} working.`);
console.log('BROKEN:', zeros.join('  '));
await c.end();
