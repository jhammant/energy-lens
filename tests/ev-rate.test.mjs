import test from 'node:test';
import assert from 'node:assert/strict';
import {tariffs} from '../dist/tariffs.mjs';
import {sum,midnight,localParts,normalizeRecords,dataStats,priceRecords,simulate,shiftEV,compare,rateAt,carRateAt,evPricing,evSplit,clockMinutes,compileTariff,costBreakdown,simulatedBreakdown,bandShares} from '../dist/engine.mjs';
const near=(actual,expected,eps=1e-7)=>assert.ok(Math.abs(actual-expected)<eps,`${actual} != ${expected}`);
const HH=1800000;
// Synthetic half-hourly readings: `home` kWh of household use per slot plus car kWh from car(date, minute), recorded in an EV column.
const readings=(date,next,home,car=()=>0)=>normalizeRecords(Array.from({length:(midnight(next)-midnight(date))/HH},(_,i)=>{
 const start=midnight(date)+i*HH,p=localParts(start),ev=car(p.date,p.minute);return {start,kwh:home+ev,ev};})).records;
const wholeHouse=records=>records.map(({ev,...r})=>r);
const at=times=>(_,minute)=>times.includes(minute)?3.5:0;
const config={annualKwh:8000,evKwh:2400,homeNightShare:.25,power:7,arrival:1080,departure:420};

// Synthetic fixtures. IOG_TEST: household 7p 23:30–05:30 and 27p otherwise, EV 7p any time up to 6 kWh a day.
const win=(start,end)=>({start,end});
const IOG_TEST={id:'custom-iogtest',supplier:'Octopus',name:'Intelligent Go (test)',standingChargePencePerDay:50,
 bands:[{name:'Night',ratePencePerKWh:7,windows:[win('23:30','05:30')]},{name:'Day',ratePencePerKWh:27,windows:[]}],ev:{ratePencePerKWh:7,windows:[],dailyCapKWh:6}};
// DEDICATED: Freephase-style bands with a 9p EV rate from 22:00 to 02:00 (wraps midnight, no cap).
const FREEPHASE={id:'custom-freephase',supplier:'EDF',name:'Freephase Static 24m',standingChargePencePerDay:54.73,bands:[
 {name:'Green',ratePencePerKWh:16.61,windows:[win('23:00','06:00')]},{name:'Amber',ratePencePerKWh:24.99,windows:[win('06:00','16:00'),win('19:00','23:00')]},{name:'Red',ratePencePerKWh:45.42,windows:[]}]};
const DEDICATED={...FREEPHASE,id:'custom-dedicated',ev:{ratePencePerKWh:9,windows:[win('22:00','02:00')]}};
const smartSaver={id:'ss12',name:'Smart Saver',standingChargePencePerDay:61.58,bands:[
 {name:'Peak',ratePencePerKWh:41.31,windows:[win('16:00','19:00')]},{name:'Super Off Peak',ratePencePerKWh:16.21,windows:[win('02:00','05:00')]},{name:'Off Peak',ratePencePerKWh:24.19,windows:[win('05:00','16:00'),win('19:00','02:00')]}]};
const ovo={...tariffs.find(t=>t.id==='ovo'),day:30,standing:50};
const minutes=(...times)=>times.map(clockMinutes);

test('the EV rate prices car kWh only; household kWh stay on the bands',()=>{
 const anyTime=compileTariff({...FREEPHASE,ev:{ratePencePerKWh:9}}),plain=compileTariff(FREEPHASE);
 const records=readings('2026-01-10','2026-01-11',.2,at(minutes('18:00')));
 const withEV=priceRecords(records,anyTime),without=priceRecords(records,plain);
 // Same records without the EV rate put the 3.5 kWh of car use in Red (45.42p); with it, that car kWh costs 9p.
 near(withEV.energy,without.energy-3.5*45.42/100+3.5*9/100);
 assert.equal(withEV.evKwh,3.5);assert.equal(withEV.evApplied,true);
 // A day with no car use costs exactly the same with or without the EV rate.
 const homeOnly=readings('2026-01-10','2026-01-11',.2);
 assert.equal(priceRecords(homeOnly,anyTime).total,priceRecords(homeOnly,plain).total);
 assert.equal(anyTime.ev.anyTime,true);assert.equal(anyTime.ev.cap,null);
});

test('EV windows wrap midnight with an exclusive end and are independent of the bands',()=>{
 const t=compileTariff(DEDICATED);
 for(const time of ['22:00','23:30','00:00','01:30'])assert.equal(carRateAt(t,clockMinutes(time)),9,time);
 assert.equal(carRateAt(t,clockMinutes('02:00')),16.61);assert.equal(carRateAt(t,clockMinutes('21:30')),24.99);
 // Household use keeps the band rate inside the EV window.
 assert.equal(rateAt(t,clockMinutes('23:30')),16.61);
 assert.equal(evPricing(t).slots.filter(Boolean).length,8);
 const records=readings('2026-01-10','2026-01-11',0,(_,m)=>minutes('01:30','02:00','21:30','23:00').includes(m)?1:0);
 const p=priceRecords(records,t);
 near(p.energy,(9+16.61+24.99+9)/100);assert.equal(p.evKwh,2);
});

test('the daily cap spills car kWh over the cap to the band rate and resets each local day',()=>{
 const t=compileTariff(IOG_TEST),records=readings('2026-01-10','2026-01-12',.2,at(minutes('18:00','18:30','19:00')));
 const split=evSplit(records,t),pick=date=>minutes('18:00','18:30','19:00').map(m=>split[records.findIndex(r=>r.date===date&&r.minute===m)]);
 assert.deepEqual(pick('2026-01-10'),[3.5,2.5,0]);assert.deepEqual(pick('2026-01-11'),[3.5,2.5,0]);
 const p=priceRecords(records,t),householdPerDay=.2*(12*7+36*27)/100;
 near(p.energy,2*(householdPerDay+(6*7+4.5*27)/100));assert.equal(p.evKwh,12);
 // The 50-interval autumn clock-change day still caps per local date.
 const autumn=readings('2026-10-24','2026-10-26',.2,at(minutes('18:00','18:30','19:00')));assert.equal(autumn.filter(r=>r.date==='2026-10-25').length,50);
 const s=evSplit(autumn,t);for(const date of ['2026-10-24','2026-10-25'])near(sum(s.filter((_,i)=>autumn[i].date===date)),6);
});

test('charging on arrival in the annual model gets the EV rate up to the cap and the band rate after it',()=>{
 const t=compileTariff(IOG_TEST),c={...config,evKwh:2401.7},p=simulate(c,t,false),car=2401.7/365;
 near(sum(p.evRatedProfile),6);near(p.evRatedProfile[36],3.5);near(p.evRatedProfile[37],2.5);assert.equal(p.evRatedProfile[38],0);
 near(p.evProfile[37]-p.evRatedProfile[37],car-6);
 near(p.evCost,365*(6*7+(car-6)*27)/100);
 // Household: 14 night-share slots (12 at 7p, 23:00 and 05:30 at 27p) and 34 day slots at 27p.
 const home=(8000-2401.7)/365,n=home*.25/14,d=home*.75/34;
 near(p.total,365*(12*n*7+2*n*27+34*d*27+6*7+(car-6)*27)/100+365*.5,1e-6);assert.equal(p.evApplied,true);
});

test('overnight charging prefers the cheapest car rate, then the cheapest band, and leaves other tariffs as before',()=>{
 const t=compileTariff(IOG_TEST),c={...config,evKwh:2401.7},p=simulate(c,t,true),night=i=>t.slots[i]===0;
 assert.ok(p.evProfile.every((v,i)=>v===0||night(i)));near(p.evProfile[47],3.5);near(p.evProfile[0],2401.7/365-3.5);
 // Spill over the cap lands in the Night band, so every car kWh costs 7p.
 near(p.evCost,2401.7*7/100);
 const records=readings('2026-01-10','2026-01-12',.2,at(minutes('18:00','18:30','19:00')));
 const oneNight=readings('2026-01-10','2026-01-12',.2,(d,m)=>d==='2026-01-10'&&minutes('18:00','18:30','19:00').includes(m)?3.5:0),shifted=shiftEV(oneNight,t,config);
 near(sum(shifted.records.map(r=>r.kwh)),sum(oneNight.map(r=>r.kwh)));near(shifted.unshifted,0);
 assert.ok(shifted.records.every(r=>r.ev===0||inNight(r.minute)));
 // 23:30 on the 10th, then 00:00 and 00:30 on the 11th. The cap is per local date: 3.5 kWh on the 10th and 6 of 7 on the 11th.
 assert.deepEqual(shifted.records.filter(r=>r.ev>0).map(r=>[r.date,r.minute]),[['2026-01-10',1410],['2026-01-11',0],['2026-01-11',30]]);
 near(sum(evSplit(shifted.records,t)),3.5+6);
 function inNight(m){return m>=clockMinutes('23:30')||m<clockMinutes('05:30');}
 // Without an EV rate the order is rateAt then arrival, exactly as before: SS12 fills Super Off Peak from 02:00.
 const ss=compileTariff(smartSaver),q=simulate(config,ss,true);
 assert.equal(q.evProfile[4],3.5);near(q.evProfile[5],2400/365-3.5);assert.equal(sum(q.evProfile.filter((_,i)=>i!==4&&i!==5)),0);
 assert.ok(q.evRatedProfile.every(v=>v===0));assert.equal(q.evApplied,undefined);
 const ssShift=shiftEV(records,ss,config).records.filter(r=>r.ev>0).map(r=>[r.date,r.minute,r.ev]);
 // Night of the 10th: three 3.5 kWh sessions fill 02:00–03:30 Super Off Peak. The readings end at 23:30 on the 11th, so that night's
 // charging fills the cheapest slots it still has: Off Peak from 19:00 (the 18:00 Peak slot is dearer).
 assert.deepEqual(ssShift,[['2026-01-11',120,3.5],['2026-01-11',150,3.5],['2026-01-11',180,3.5],['2026-01-11',1140,3.5],['2026-01-11',1170,3.5],['2026-01-11',1200,3.5]]);
 // EV-only has no preference, so it keeps arrival order.
 const o=simulate(config,ovo,true);assert.equal(o.evProfile[36],3.5);near(o.evProfile[37],2400/365-3.5);
 assert.deepEqual(shiftEV(records,ovo,config).records.map(r=>r.ev),records.map(r=>r.ev));
});

test('tariffs saved without an EV rate compile and price exactly as before',()=>{
 const records=readings('2026-01-10','2026-01-12',.2,at(minutes('18:00')));
 const base=compileTariff(smartSaver);assert.equal(base.ev,null);
 for(const ev of [undefined,null]){const t=compileTariff({...smartSaver,ev});assert.equal(t.ev,null);
  assert.equal(priceRecords(records,t).total,priceRecords(records,base).total);assert.equal(simulate(config,t,true).total,simulate(config,base,true).total);
  assert.equal(costBreakdown(records,t).total,costBreakdown(records,base).total);}
 const b=costBreakdown(records,base);assert.equal(b.bands.length,3);assert.ok(b.bands.every(x=>!x.ev));assert.equal(b.evApplied,undefined);
 assert.equal(priceRecords(records,base).evApplied,undefined);
 const r=simulate(config,ovo,true);near(r.total,(8000-2400)*.3+2400*.1333+365*.5);near(r.evCost,2400*.1333);
});

test('cost breakdowns and band shares reconcile with ranked totals, including the EV line',()=>{
 for(const def of [IOG_TEST,DEDICATED]){const t=compileTariff(def);
  const records=readings('2026-01-30','2026-02-03',.2,(_,m)=>minutes('18:00','18:30','19:00','23:00').includes(m)?3.5:0);
  const b=costBreakdown(records,t),p=priceRecords(records,t),stats=dataStats(records);
  assert.equal(b.energy,p.energy);assert.equal(b.total,p.total);assert.equal(b.evApplied,true);
  near(sum(b.bands.map(x=>x.cost)),p.energy);near(sum(b.bands.map(x=>x.kwh)),stats.kwh);
  const last=b.bands.at(-1);assert.equal(last.name,'EV charging');assert.equal(last.ev,true);assert.equal(last.rate,t.ev.rate);near(last.kwh,p.evKwh);
  assert.equal(b.months.length,2);near(sum(b.months.map(m=>m.energy)),b.energy);near(sum(b.months.map(m=>m.total)),b.total);
  for(const m of b.months){near(sum(m.bands.map(x=>x.kwh)),m.kwh);near(sum(m.bands.map(x=>x.cost)),m.energy);}
  const ranked=compare(config,records,[t,compileTariff(FREEPHASE)],false,t.id).find(x=>x.id===t.id);assert.equal(ranked.active.total,p.total);
  for(const shift of [false,true]){const s=simulate(config,t,shift),sb=simulatedBreakdown(t,s);
   near(sum(sb.bands.map(x=>x.cost)),s.energy,1e-6);near(sum(sb.bands.map(x=>x.kwh)),config.annualKwh,1e-6);assert.equal(sb.bands.at(-1).ev,true);
   const modelled=compare(config,[],[t],shift,t.id)[0];assert.equal(modelled.active.total,s.total);}
  for(const shares of [bandShares(b),bandShares(simulatedBreakdown(t,simulate(config,t,false)))]){
   assert.equal(sum(shares.map(x=>x.kwhPct)),100);assert.equal(sum(shares.map(x=>x.costPct)),100);assert.equal(shares.at(-1).ev,true);}
 }
});

test('whole-house readings price everything at the bands and say the EV rate was not applied',()=>{
 const t=compileTariff(IOG_TEST),records=wholeHouse(readings('2026-01-10','2026-01-12',.2,at(minutes('18:00','18:30','19:00'))));
 const p=priceRecords(records,t),plain=compileTariff({...IOG_TEST,ev:undefined});
 assert.equal(p.evApplied,false);assert.equal(p.evKwh,0);assert.equal(p.total,priceRecords(records,plain).total);
 const b=costBreakdown(records,t);assert.equal(b.evApplied,false);assert.ok(b.bands.every(x=>!x.ev));assert.equal(b.total,p.total);
 const ranked=compare(config,records,[t,ovo],false,t.id);assert.ok(ranked.find(x=>x.id===t.id).active);assert.equal(ranked.find(x=>x.id==='ovo').active,null);
});

test('invalid EV settings are rejected with a clear reason',()=>{
 const ev=e=>({...IOG_TEST,ev:e}),base={ratePencePerKWh:7};
 const cases=[
  [ev([7]),/EV charging settings are not valid/],[ev('7p'),/EV charging settings are not valid/],[ev(7),/EV charging settings are not valid/],
  [ev({ratePencePerKWh:-1}),/EV charging rate must be between 0 and 200p/],[ev({ratePencePerKWh:201}),/EV charging rate must be between 0 and 200p/],
  [ev({ratePencePerKWh:'7'}),/EV charging rate must be between 0 and 200p/],[ev({}),/EV charging rate must be between 0 and 200p/],
  [ev({...base,windows:Array.from({length:9},(_,i)=>win(`0${i}:00`,`0${i}:30`))}),/up to eight time windows/],
  [ev({...base,windows:'x'}),/up to eight time windows/],[ev({...base,windows:null}),/up to eight time windows/],
  [ev({...base,windows:[win('12:15','13:00')]}),/half-hour/],[ev({...base,windows:[win('01:00','01:00')]}),/EV charging: choose different start and end times/],
  [ev({...base,windows:[win('22:00','02:00'),win('01:00','03:00')]}),/EV charging has overlapping windows at 01:00–01:30/],
  [ev({...base,dailyCapKWh:0}),/EV daily cap between 0.1 and 200 kWh/],[ev({...base,dailyCapKWh:201}),/EV daily cap/],[ev({...base,dailyCapKWh:'six'}),/EV daily cap/],
  [{...IOG_TEST,bands:[{...IOG_TEST.bands[0],name:' ev Charging '},IOG_TEST.bands[1]]},/“EV charging” is used for the EV rate/],
 ];
 for(const [def,pattern] of cases)assert.throws(()=>compileTariff(def),pattern,JSON.stringify(def.ev));
 // The reserved name is fine without an EV rate; an EV window may overlap any band.
 assert.doesNotThrow(()=>compileTariff({...IOG_TEST,ev:undefined,bands:[{...IOG_TEST.bands[0],name:'EV charging'},IOG_TEST.bands[1]]}));
 const e=compileTariff(ev(base)).ev;assert.equal(e.anyTime,true);assert.equal(e.cap,null);assert.deepEqual(e.windows,[]);
 assert.equal(compileTariff(ev({...base,windows:[win('23:00','05:00')],dailyCapKWh:.1})).ev.cap,.1);
});

test('EV settings round-trip through JSON',()=>{
 for(const def of [IOG_TEST,DEDICATED]){const copy=JSON.parse(JSON.stringify(def)),t=compileTariff(copy);
  assert.deepEqual(t.def.ev,def.ev);assert.deepEqual({rate:t.ev.rate,cap:t.ev.cap},{rate:def.ev.ratePencePerKWh,cap:def.ev.dailyCapKWh??null});}
});
