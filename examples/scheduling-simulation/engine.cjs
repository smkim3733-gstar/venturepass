(function(root){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const min=x=>Number(x.slice(0,2))*60+Number(x.slice(3));
  const time=x=>String(Math.floor(x/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0');
  const fields=['interpreterId','roomId','buyerId','exhibitorId'];
  function config(fixture,scenarioId){
    const c=copy(fixture), change=c.scenarios.find(s=>s.id===scenarioId)?.change;
    if(!change) return c;
    if(change.type==='interpreter-availability') c.interpreters.find(x=>x.id===change.id).available=[{start:change.start,end:change.end}];
    if(change.type==='room-unavailable') c.rooms.find(x=>x.id===change.id).available=[];
    if(change.type==='buyer-availability') c.buyers.find(x=>x.id===change.id).available=[{start:change.start,end:change.end}];
    if(change.type==='interpreters-unavailable') for(const x of c.interpreters) if(change.ids.includes(x.id)) x.available=[];
    return c;
  }
  function problems(s,others,c){
    const issues=[];
    const from=min(s.start),to=min(s.end);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to-from!==c.rules.durationMinutes||from<min(c.event.start)||to>min(c.event.end)) issues.push('행사시간·상담길이 불일치');
    for(const [field,key,label] of [['interpreterId','interpreters','통역사'],['roomId','rooms','공간'],['buyerId','buyers','바이어'],['exhibitorId','exhibitors','참가기업']]){
      const r=c[key].find(x=>x.id===s[field]);
      if(!r){issues.push(label+' 없음');continue;}
      if(field==='interpreterId'&&!r.languages.includes(s.language))issues.push('요청 언어 불일치');
      if(!r.available.some(w=>from>=min(w.start)&&to<=min(w.end)))issues.push(label+' 가용시간 불일치');
    }
    for(const o of others) if(o.id!==s.id) for(const f of fields) if(o[f]===s[f]){
      const gap=f==='interpreterId'?c.rules.interpreterBufferMinutes:0;
      if(!(to+gap<=min(o.start)||min(o.end)+gap<=from))issues.push(f==='interpreterId'?'통역사 중복·간격 위반':'자원 시간 중복');
    }
    return [...new Set(issues)];
  }
  function propose(fixture,scenarioId){
    if(!fixture.scenarios.some(x=>x.id===scenarioId))throw Error('알 수 없는 장면');
    const c=config(fixture,scenarioId), baseline=copy(fixture.sessions);
    const affected=baseline.filter(s=>problems(s,baseline,c).length);
    const affectedIds=new Set(affected.map(s=>s.id));
    const kept=baseline.filter(s=>!affectedIds.has(s.id));
    const scheduled=copy(kept),changes=[],unassigned=[];
    for(const s of affected){
      let best=null,score=Infinity;
      for(let start=min(c.event.start);start+c.rules.durationMinutes<=min(c.event.end);start+=10)
        for(const interpreter of c.interpreters) for(const room of c.rooms){
          const n={...s,start:time(start),end:time(start+c.rules.durationMinutes),interpreterId:interpreter.id,roomId:room.id};
          if(problems(n,scheduled,c).length) continue;
          const rank=Math.abs(start-min(s.start))*10+(interpreter.id!==s.interpreterId?10000:0)+(room.id!==s.roomId?100:0);
          if(rank<score){best=n;score=rank;}
        }
      if(best){scheduled.push(best);changes.push({id:s.id,before:s,after:best});}
      else{
        const languageAvailable=c.interpreters.some(x=>x.languages.includes(s.language)&&x.available.length);
        unassigned.push({id:s.id,reason:languageAvailable?'기존 일정 유지·10분 탐색 간격에서 후보 없음':'요청 언어의 가용 통역사 없음'});
      }
    }
    return {scenarioId,affected:affected.map(s=>s.id),kept:kept.map(s=>s.id),changes,unassigned,
      proposed:scheduled.sort((a,b)=>a.id.localeCompare(b.id)),violationCount:scheduled.filter(s=>problems(s,scheduled,c).length).length,
      algorithm:'기존 유효 배치를 고정한 순차 탐색. 10분 단위 후보. 전역 최적해·일반적 배정 불가능 증명 아님.'};
  }
  const api={config,problems,propose};
  if(typeof module!=='undefined')module.exports=api;else root.DemoEngine=api;
})(typeof window==='undefined'?globalThis:window);
