import test from 'node:test';
import assert from 'node:assert/strict';
import {tariffs} from '../dist/tariffs.mjs';
import {sum,midnight,normalizeRecords,dataStats,priceRecords,simulate,shiftEV,compare,rateAt,clockMinutes,compileTariff,tariffBands,costBreakdown,rateSteps,bandWindows,bandShares} from '../dist/engine.mjs';
const near=(actual,expected,eps=1e-7)=>assert.ok(Math.abs(actual-expected)<eps,`${actual} != ${expected}`);
const kwhAt=(date,next,f)=>normalizeRecords(Array.from({length:(midnight(next)-midnight(date))/1800000},(_,i)=>({start:midnight(date)+i*1800000,kwh:f(i)}))).records;
const day=(date,next,kwh=.5)=>kwhAt(date,next,()=>kwh);
const config={annualKwh:8000,evKwh:2400,homeNightShare:.25,power:7,arrival:1080,departure:420};
const edf=tariffs.find(t=>t.id==='edf-standard');

// Example tariffs: rates only, used as synthetic fixtures.
const win=(start,end)=>({start,end});
const smartSaver=(name,peak,off,sop)=>({id:name.toLowerCase().replace(/\W+/g,'-'),name,standingChargePencePerDay:61.58,bands:[
 {name:'Peak',ratePencePerKWh:peak,windows:[win('16:00','19:00')]},
 {name:'Super Off Peak',ratePencePerKWh:sop,windows:[win('02:00','05:00')]},
 {name:'Off Peak',ratePencePerKWh:off,windows:[win('05:00','16:00'),win('19:00','02:00')]}]});
const SS12=smartSaver('E.ON Next Smart Saver Fixed 12m',41.31,24.19,16.21);
const SS24=smartSaver('E.ON Next Smart Saver Fixed 24m',41.77,24.35,16.71);
const GREEN={id:'100green',name:'100Green Fixed to Oct 2027',standingChargePencePerDay:61.22,bands:[{name:'All day',ratePencePerKWh:26.50,windows:[]}]};
const PLEDGE={id:'pledge',name:'E.ON Next Pledge Tracker',standingChargePencePerDay:61.58,bands:[{name:'All day',ratePencePerKWh:24.46,windows:[]}]};
const bandKwh=(records,t)=>Object.fromEntries(costBreakdown(records,t).bands.map(b=>[b.name,b.kwh]));
const bandSlots=(records,t)=>Object.fromEntries(t.bands.map((b,i)=>[b.name,records.filter(r=>t.slots[Math.floor(r.minute/30)]===i).length]));

test('clock times must be half-hour boundaries within a day',()=>{
 assert.equal(clockMinutes('00:00'),0);assert.equal(clockMinutes('23:30'),1410);
 for(const bad of ['12:15','24:00','7:00','',undefined])assert.throws(()=>clockMinutes(bad),/half-hour/);
});

test('three-band rates honour exclusive ends and the window that wraps midnight',()=>{
 const t=compileTariff(SS12);
 const expected={'16:00':41.31,'18:30':41.31,'19:00':24.19,'02:00':16.21,'04:30':16.21,'05:00':24.19,'23:30':24.19,'00:00':24.19,'01:30':24.19,'15:30':24.19};
 for(const [time,rate] of Object.entries(expected))assert.equal(rateAt(t,clockMinutes(time)),rate,time);
 assert.equal(t.type,'bands');assert.equal(t.cheapRate,16.21);
});

test('an all-other-times band compiles to the same slots as explicit windows',()=>{
 const fallback={...SS12,bands:SS12.bands.map(b=>b.name==='Off Peak'?{...b,windows:[]}:b)};
 assert.deepEqual(compileTariff(fallback).slots,compileTariff(SS12).slots);
 assert.equal(compileTariff(fallback).bands[2].fallback,true);
});

test('invalid tariffs are rejected with a clear reason',()=>{
 const withBands=bands=>({...SS12,bands});
 const peak={name:'Peak',ratePencePerKWh:41.31,windows:[win('16:00','19:00')]};
 const cases=[
  [withBands([peak,{name:'Off Peak',ratePencePerKWh:24,windows:[win('18:00','02:00')]},{name:'Rest',ratePencePerKWh:20,windows:[]}]),/Peak and Off Peak both cover 18:00–18:30/],
  [withBands([{...peak,windows:[win('16:00','19:00'),win('18:30','20:00')]},{name:'Rest',ratePencePerKWh:20,windows:[]}]),/Peak has overlapping windows at 18:30/],
  [withBands([peak,{name:'Night',ratePencePerKWh:10,windows:[win('00:00','07:00')]}]),/No band covers 07:00–16:00/],
  [withBands([peak,{name:'A',ratePencePerKWh:10,windows:[]},{name:'B',ratePencePerKWh:12,windows:[]}]),/Only one band/],
  [withBands([{...peak,windows:[win('00:00','12:00'),win('12:00','00:00')]},{name:'Rest',ratePencePerKWh:20,windows:[]}]),/covers no time/],
  [withBands([{...peak,windows:[win('16:00','16:00')]}]),/different start and end/],
  [withBands([{...peak,windows:[win('12:15','19:00')]}]),/half-hour/],
  [withBands([{...peak,windows:[win('16:00','24:00')]}]),/half-hour/],
  [{...SS12,name:'  '},/name/],
  [withBands([{name:'All day',ratePencePerKWh:-1,windows:[]}]),/All day rate must be between 0 and 200p/],
  [withBands([{name:'All day',ratePencePerKWh:201,windows:[]}]),/between 0 and 200p/],
  [withBands([{name:'All day',ratePencePerKWh:'24',windows:[]}]),/between 0 and 200p/],
  [{...SS12,standingChargePencePerDay:null},/standing charge/],
  [withBands([]),/between one and six/],
  [withBands([{...peak},{...peak,name:'peak'}]),/different name/],
 ];
 for(const [def,message] of cases)assert.throws(()=>compileTariff(def),message);
});

test('a single all-day band prices exactly like the equivalent built-in flat tariff',()=>{
 const records=kwhAt('2026-01-15','2026-01-17',i=>.1+(i%7)*.05),custom=compileTariff(PLEDGE),legacy={type:'flat',day:24.46,standing:61.58};
 near(priceRecords(records,custom).total,priceRecords(records,legacy).total);
 assert.equal(priceRecords(records,custom).cheapKwh,0);assert.equal(custom.cheapRate,null);
});

test('a normal day prices 6 peak, 6 super off-peak and 36 off-peak half-hours',()=>{
 const r=day('2026-01-15','2026-01-16'),p=priceRecords(r,compileTariff(SS12));
 near(p.energy,.5*(6*41.31+6*16.21+36*24.19)/100);near(p.standing,.6158);near(p.cheapKwh,3);
});

test('spring-forward day has 46 intervals, loses an off-peak hour, and one standing charge',()=>{
 const r=day('2026-03-29','2026-03-30'),t=compileTariff(SS12);assert.equal(r.length,46);
 assert.deepEqual(bandSlots(r,t),{'Peak':6,'Super Off Peak':6,'Off Peak':34});
 const b=costBreakdown(r,t);assert.equal(b.days,1);near(b.standing,.6158);near(b.energy,.5*(6*41.31+6*16.21+34*24.19)/100);
});

test('fall-back day has 50 intervals and prices both 01:00 hours as off-peak',()=>{
 const r=day('2026-10-25','2026-10-26'),t=compileTariff(SS12);assert.equal(r.length,50);
 assert.deepEqual(bandSlots(r,t),{'Peak':6,'Super Off Peak':6,'Off Peak':38});
 assert.equal(r.filter(x=>x.minute===60||x.minute===90).length,4);
 const b=costBreakdown(r,t);assert.equal(b.days,1);near(b.bands.find(x=>x.name==='Off Peak').kwh,19);near(b.total,priceRecords(r,t).total);
});

test('breakdown reconciles bands and months with the overall price',()=>{
 const records=kwhAt('2026-01-30','2026-02-03',i=>.2+(i%5)*.1);
 for(const t of [compileTariff(SS12),compileTariff(GREEN),edf,tariffs.find(x=>x.id==='edf-18')]){
  const b=costBreakdown(records,t),p=priceRecords(records,t);
  near(sum(b.bands.map(x=>x.kwh)),dataStats(records).kwh);near(sum(b.bands.map(x=>x.cost)),p.energy);near(b.total,p.total);near(b.standing,p.standing);
  assert.deepEqual(b.months.map(m=>[m.month,m.days]),[['2026-01',2],['2026-02',2]]);
  near(sum(b.months.map(m=>m.total)),b.total);near(sum(b.months.map(m=>m.kwh)),b.kwh);
  for(const m of b.months)near(sum(m.bands.map(x=>x.cost)),m.energy);
 }
 assert.deepEqual(tariffBands(tariffs.find(x=>x.id==='edf-18')).map(b=>b.name),['Cheap window','Rest of day']);
 assert.equal(costBreakdown(records,tariffs.find(x=>x.id==='ovo')),null);assert.equal(tariffBands(tariffs.find(x=>x.id==='ovo')),null);
});

test('months without readings still carry standing charges across gaps',()=>{
 const records=[...day('2026-01-31','2026-02-01'),...day('2026-03-01','2026-03-02')],b=costBreakdown(records,compileTariff(PLEDGE));
 assert.deepEqual(b.months.map(m=>[m.month,m.days,m.kwh]),[['2026-01',1,24],['2026-02',28,0],['2026-03',1,24]]);near(b.standing,30*.6158);
});

test('compare ranks custom tariffs against built-in ones on a synthetic week',()=>{
 const records=kwhAt('2026-01-12','2026-01-19',i=>i%48>=32&&i%48<38?.6:.2);assert.equal(dataStats(records).days,7);
 const expected={pledge:7*(12*24.46+61.58)/100,'edf-standard':7*(12*26.595+42.915)/100,'100green':7*(12*26.5+61.22)/100,
  'e-on-next-smart-saver-fixed-12m':7*(3.6*41.31+1.2*16.21+7.2*24.19+61.58)/100,'e-on-next-smart-saver-fixed-24m':7*(3.6*41.77+1.2*16.71+7.2*24.35+61.58)/100};
 const rows=compare(config,records,[edf,...[SS12,SS24,GREEN,PLEDGE].map(compileTariff)]);
 assert.deepEqual(rows.map(r=>r.id),['pledge','edf-standard','100green','e-on-next-smart-saver-fixed-12m','e-on-next-smart-saver-fixed-24m']);
 for(const r of rows)near(r.active.total,expected[r.id]);
 near(bandKwh(records,compileTariff(SS12)).Peak,7*3.6);
});

test('measured EV charging moves into the cheapest custom band and conserves energy',()=>{
 const t=compileTariff(SS12),records=day('2026-01-12','2026-01-14',.2).map(r=>{const ev=r.date==='2026-01-12'&&r.minute===1080?3:0;return {...r,ev,kwh:r.kwh+ev};});
 const s=shiftEV(records,t,config);near(sum(s.records.map(r=>r.kwh)),sum(records.map(r=>r.kwh)));near(s.unshifted,0);
 assert.ok(s.records.filter(r=>r.ev>0).every(r=>rateAt(t,r.minute)===16.21));
 assert.ok(priceRecords(s.records,t).total<priceRecords(records,t).total);
});

test('annual simulation prices custom bands and conserves energy',()=>{
 const t=compileTariff(SS12),a=simulate(config,t,false),b=simulate(config,t,true);
 near(sum(a.profile)*365,8000);near(sum(b.profile)*365,8000);assert.ok(b.total<a.total);
 near(a.energy,sum(a.profile.map((v,i)=>v*rateAt(t,i*30)/100))*365);near(a.standing,365*.6158);
});
test('supplier is optional for legacy custom tariffs and validated when given',()=>{
 assert.equal(compileTariff(PLEDGE).supplier,'');assert.equal(compileTariff({...PLEDGE,supplier:null}).supplier,'');assert.equal(compileTariff({...PLEDGE,supplier:'   '}).supplier,'');
 assert.equal(compileTariff({...PLEDGE,supplier:'  Acme Energy '}).supplier,'Acme Energy');
 for(const bad of ['x'.repeat(81),42])assert.throws(()=>compileTariff({...PLEDGE,supplier:bad}),/supplier a name of up to 80/);
});
test('compare measures savings against the chosen baseline with safe fallbacks',()=>{
 const records=kwhAt('2026-01-12','2026-01-19',i=>i%48>=32&&i%48<38?.6:.2),list=[edf,...[SS12,PLEDGE].map(compileTariff)];
 const total=rows=>Object.fromEntries(rows.map(r=>[r.id,r.active.total]));
 const rows=compare(config,records,list,false,'pledge'),t=total(rows),pledge=rows.find(r=>r.id==='pledge');
 assert.ok(pledge.isBaseline);assert.equal(pledge.saving,0);assert.equal(rows.filter(r=>r.isBaseline).length,1);
 for(const r of rows)near(r.saving,t.pledge-r.active.total);
 const byDefault=compare(config,records,list),edfTotal=total(byDefault)['edf-standard'];
 assert.ok(byDefault.find(r=>r.id==='edf-standard').isBaseline);for(const r of byDefault)near(r.saving,edfTotal-r.active.total);
 for(const id of ['missing',tariffs.find(x=>x.id==='british-gas').id]){const f=compare(config,records,[...list,tariffs.find(x=>x.id==='british-gas')],false,id);assert.ok(f.find(r=>r.id==='edf-standard').isBaseline,id);}
 const noEdf=[SS12,PLEDGE].map(compileTariff),first=compare(config,records,noEdf,false,'missing');
 assert.ok(first.find(r=>r.id==='e-on-next-smart-saver-fixed-12m').isBaseline);
 const sim=compare(config,[],[edf,compileTariff(PLEDGE)],true,'pledge');near(sim.find(r=>r.id==='pledge').saving,simulate(config,compileTariff(PLEDGE),false).total-simulate(config,compileTariff(PLEDGE),true).total);
 assert.throws(()=>compare(config,records,[tariffs.find(x=>x.id==='ovo')]),/at least one tariff/);
});
test('rate steps describe each tariff across a whole day for the chart',()=>{
 const steps=t=>rateSteps(t).map(s=>[s.start,s.end,s.name,s.rate]);
 assert.deepEqual(steps(compileTariff(SS12)),[[0,120,'Off Peak',24.19],[120,300,'Super Off Peak',16.21],[300,960,'Off Peak',24.19],[960,1140,'Peak',41.31],[1140,1440,'Off Peak',24.19]]);
 assert.deepEqual(steps(compileTariff(PLEDGE)),[[0,1440,'All day',24.46]]);
 // Published rates come from the dated snapshot in core/tariffs.mjs, so read them rather than hard-coding a price refresh.
 const edf18=tariffs.find(x=>x.id==='edf-18');
 assert.deepEqual(steps(edf18),[[0,360,'Cheap window',edf18.night],[360,1380,'Rest of day',edf18.day],[1380,1440,'Cheap window',edf18.night]]);
 assert.deepEqual(steps(edf),[[0,1440,'All day',edf.day]]);
 assert.equal(rateSteps(tariffs.find(x=>x.id==='ovo')),null);assert.equal(rateSteps(tariffs.find(x=>x.id==='british-gas')),null);
 for(const t of [compileTariff(SS12),compileTariff(PLEDGE),...tariffs.filter(x=>rateSteps(x))]){const s=rateSteps(t);
  assert.equal(sum(s.map(x=>x.end-x.start)),1440);assert.equal(s[0].start,0);assert.equal(s.at(-1).end,1440);
  for(const x of s){assert.equal(x.rate,rateAt(t,x.start));assert.equal(x.rate,rateAt(t,x.end-30));}}
});
// Synthetic three-rate fixture shaped like a Freephase-style tariff, with Red as the fallback band.
const FREEPHASE={id:'freephase',supplier:'EDF',name:'Freephase Static 24m',standingChargePencePerDay:54.73,bands:[
 {name:'Green',ratePencePerKWh:16.61,windows:[win('23:00','06:00')]},
 {name:'Amber',ratePencePerKWh:24.99,windows:[win('06:00','16:00'),win('19:00','23:00')]},
 {name:'Red',ratePencePerKWh:45.42,windows:[]}]};
test('band windows merge contiguous slots, keep midnight runs whole and resolve the fallback band',()=>{
 const w=t=>bandWindows(t).map(b=>[b.name,b.windows.map(x=>[x.start,x.end])]);
 assert.deepEqual(w(compileTariff(FREEPHASE)),[['Green',[[1380,360]]],['Amber',[[360,960],[1140,1380]]],['Red',[[960,1140]]]]);
 // Separate windows that touch at midnight become one; a fallback that ends at midnight ends at 0.
 const split={id:'split',name:'Split',standingChargePencePerDay:50,bands:[{name:'Night',ratePencePerKWh:10,windows:[win('00:00','02:00'),win('22:00','00:00')]},{name:'Day',ratePencePerKWh:30,windows:[win('02:00','12:00')]},{name:'Late',ratePencePerKWh:20,windows:[]}]};
 assert.deepEqual(w(compileTariff(split)),[['Night',[[1320,120]]],['Day',[[120,720]]],['Late',[[720,1320]]]]);
 const tail={id:'tail',name:'Tail',standingChargePencePerDay:50,bands:[{name:'Cheap',ratePencePerKWh:10,windows:[win('00:00','05:00')]},{name:'Rest',ratePencePerKWh:30,windows:[]}]};
 assert.deepEqual(w(compileTariff(tail)),[['Cheap',[[0,300]]],['Rest',[[300,0]]]]);
 assert.deepEqual(w(compileTariff(PLEDGE)),[['All day',[[0,1440]]]]);
 assert.deepEqual(w(tariffs.find(x=>x.id==='edf-18')),[['Cheap window',[[1380,360]]],['Rest of day',[[360,1380]]]]);
 assert.equal(bandWindows(tariffs.find(x=>x.id==='ovo')),null);assert.equal(bandWindows(tariffs.find(x=>x.id==='british-gas')),null);
 // Windows cover every half-hour exactly once and agree with rateAt.
 for(const t of [compileTariff(FREEPHASE),compileTariff(split),compileTariff(tail),compileTariff(SS12),compileTariff(PLEDGE),...tariffs.filter(x=>tariffBands(x))]){
  const seen=Array(48).fill(0),slotsOf=x=>{const n=((x.end-x.start+1440)%1440||1440)/30;return Array.from({length:n},(_,j)=>(x.start/30+j)%48);};
  for(const b of bandWindows(t))for(const x of b.windows)for(const k of slotsOf(x)){seen[k]++;assert.equal(rateAt(t,k*30),b.rate);}
  assert.deepEqual(seen,Array(48).fill(1),t.name);}
});
test('band shares add up to 100 and reconcile with the cost breakdown',()=>{
 const records=kwhAt('2026-01-30','2026-02-03',i=>.2+(i%7)*.13);
 for(const t of [compileTariff(FREEPHASE),compileTariff(SS12),compileTariff(PLEDGE),tariffs.find(x=>x.id==='edf-18')]){
  const b=costBreakdown(records,t),s=bandShares(b);
  assert.equal(sum(s.map(x=>x.kwhPct)),100);assert.equal(sum(s.map(x=>x.costPct)),100);near(sum(s.map(x=>x.kwhShare)),1);near(sum(s.map(x=>x.costShare)),1);
  s.forEach((x,i)=>{near(x.kwhShare,b.bands[i].kwh/b.kwh);near(x.costShare,b.bands[i].cost/b.energy);assert.ok(Math.abs(x.kwhPct-x.kwhShare*100)<1);assert.ok(Math.abs(x.costPct-x.costShare*100)<1);assert.equal(x.name,b.bands[i].name);});}
 // Freephase on a flat profile: Green 7h, Amber 14h, Red 3h of the day.
 const flat=bandShares(costBreakdown(day('2026-03-02','2026-03-03'),compileTariff(FREEPHASE)));
 assert.deepEqual(flat.map(x=>x.kwhPct),[29,58,13]);near(flat[2].costShare,3*45.42/(7*16.61+14*24.99+3*45.42));
 // Largest remainder: three equal thirds round to 34/33/33, and an empty breakdown gives zeros.
 assert.deepEqual(bandShares({bands:[{kwh:1,cost:1},{kwh:1,cost:1},{kwh:1,cost:1}]}).map(x=>x.kwhPct),[34,33,33]);
 assert.deepEqual(bandShares({bands:[{kwh:0,cost:0},{kwh:0,cost:0}]}).map(x=>[x.kwhPct,x.costPct,x.kwhShare]),[[0,0,0],[0,0,0]]);
 assert.deepEqual(bandShares(null),[]);
});
