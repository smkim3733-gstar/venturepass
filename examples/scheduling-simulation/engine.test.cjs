const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const E=require('./engine.cjs');
const f=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));
const clone=x=>JSON.parse(JSON.stringify(x));
test('기본 20건은 주어진 제약을 만족한다',()=>{assert.equal(f.sessions.length,20);for(const s of f.sessions)assert.deepEqual(E.problems(s,f.sessions,f),[]);});
for(const [id,affected,changed,missing] of [['SC01',1,1,0],['SC02',5,5,0],['SC03',1,1,0],['SC04',10,1,9]]){
 test(id+' 독립 장면: 영향·유지·미배정과 원본 불변',()=>{
  const original=clone(f);const r=E.propose(f,id);assert.equal(r.affected.length,affected);assert.equal(r.changes.length,changed);assert.equal(r.unassigned.length,missing);assert.equal(r.violationCount,0);assert.deepEqual(f,original);
  const c=E.config(f,id);for(const s of r.proposed)assert.deepEqual(E.problems(s,r.proposed,c),[]);
  for(const kept of r.kept)assert.deepEqual(r.proposed.find(s=>s.id===kept),f.sessions.find(s=>s.id===kept));
  assert.equal(new Set([...r.proposed.map(s=>s.id),...r.unassigned.map(s=>s.id)]).size,20);
  if(id==='SC02')for(const x of r.changes)assert.equal(x.after.roomId,'R05');
  if(id==='SC03')assert(r.changes[0].after.start>='10:00');
  if(id==='SC04')assert.equal(r.unassigned.filter(x=>x.reason==='요청 언어의 가용 통역사 없음').length,5);
 });
}
test('시간·언어·가용시간·통역사 간격 충돌을 탐지한다',()=>{
 const s=clone(f.sessions[0]);s.interpreterId='I02';assert(E.problems(s,f.sessions,f).includes('요청 언어 불일치'));
 const b=clone(f.sessions[4]);b.start='09:20';b.end='09:40';assert(E.problems(b,f.sessions,f).includes('통역사 중복·간격 위반'));
 const late=clone(f.sessions[0]);late.start='12:00';late.end='12:20';assert(E.problems(late,f.sessions,f).includes('행사시간·상담길이 불일치'));
});
test('알 수 없는 장면을 성공 결과로 생성하지 않는다',()=>assert.throws(()=>E.propose(f,'SC99')));
test('공개 HTML은 로컬 fixture와 engine만 포함하고 고객·외부 자원을 포함하지 않는다',async()=>{
 const {render}=await import('./build.mjs');const html=await render();
 assert(html.includes("connect-src 'none'"));assert(html.includes('const FIXTURE='));
 assert(!html.includes('{{ENGINE}}'));assert(!html.includes('{{FIXTURE}}'));
 assert(!/<(?:script|link|img|iframe)[^>]+(?:src|href)\s*=/i.test(html));
 assert(!/SIM-[ABC]|6,600|2,400|1억|sourceBasis|planVersion|[A-Z]:[\\/]/.test(html));
});
