import test from 'node:test';
import assert from 'node:assert/strict';
import {tariffs} from '../dist/tariffs.mjs';
import {sum,parseTimestamp,localParts,midnight,normalizeRecords,dataStats,parseCSV,recordsFromCSV,simulate,priceRecords,shiftEV,billCost,rateAt,recordsToCSV} from '../dist/engine.mjs';
const flat=tariffs.find(t=>t.id==='edf-standard'),evTariff=tariffs.find(t=>t.id==='edf-18');
const config={annualKwh:8000,evKwh:2400,homeNightShare:.25,power:7,arrival:1080,departure:420};
const near=(actual,expected,eps=1e-7)=>assert.ok(Math.abs(actual-expected)<eps,`${actual} != ${expected}`);
function day(date,next,kwh=.5){return normalizeRecords(Array.from({length:(midnight(next)-midnight(date))/1800000},(_,i)=>({start:midnight(date)+i*1800000,kwh}))).records;}
test('flat cost includes 365 daily standing charges and conserves energy',()=>{const result=simulate(config,flat);near(result.total,8000*.26595+365*.42915);near(sum(result.profile)*365,8000);});
test('overnight scheduling preserves car and household energy while lowering EV cost',()=>{const a=simulate(config,evTariff,false),b=simulate(config,evTariff,true);near(sum(a.evProfile)*365,2400);near(sum(b.evProfile)*365,2400);near(a.total-b.total,2400*(.33948-.0666));for(let i=0;i<48;i++)near(a.profile[i]-a.evProfile[i],b.profile[i]-b.evProfile[i]);});
test('rates respect each guaranteed window and end is exclusive',()=>{assert.equal(rateAt(evTariff,1380),6.66);assert.equal(rateAt(evTariff,330),6.66);assert.equal(rateAt(evTariff,360),33.948);assert.equal(rateAt(evTariff,1379),33.948);});
test('spring clock change has 46 intervals but one standing charge',()=>{const records=day('2026-03-29','2026-03-30');const s=dataStats(records);assert.equal(s.expected,46);assert.equal(s.missing,0);assert.equal(s.days,1);near(priceRecords(records,flat).standing,.42915);});
test('autumn clock change has 50 intervals and both 01:00 readings are retained',()=>{const r=day('2026-10-25','2026-10-26');assert.equal(r.length,50);assert.equal(r.filter(v=>v.minute===60).length,2);assert.equal(dataStats(r).missing,0);});
test('missing intervals are not zero and gaps across days are counted',()=>{const r=day('2026-09-01','2026-09-02');r.splice(5,1);const s=dataStats(r);assert.equal(s.missing,1);assert.equal(s.kwh,23.5);});
test('offsets and naive UTC map to UK clock time correctly',()=>{near(parseTimestamp('2026-09-01T00:00:00+01:00'),parseTimestamp('2026-08-31T23:00:00Z'));assert.equal(localParts(parseTimestamp('2026-08-31 23:00','UTC')).date,'2026-09-01');});
test('ambiguous and nonexistent naive local times fail rather than guessing',()=>{assert.throws(()=>parseTimestamp('2026-10-25 01:30','Europe/London'),/Ambiguous/);assert.throws(()=>parseTimestamp('2026-03-29 01:30','Europe/London'),/nonexistent/);assert.throws(()=>parseTimestamp('2026-09-01 00:30'),/timezone/);});
test('CSV accepts BOM, CRLF and quoted commas without dropping data',()=>{const parsed=parseCSV('\ufeffinterval_start,consumption_kwh,note\r\n2026-09-01T00:00:00+01:00,0.3,"note,with comma"\r\n');const r=recordsFromCSV(parsed,{start:'interval_start',kwh:'consumption_kwh',zone:'offset'});assert.equal(r.records.length,1);assert.equal(r.records[0].kwh,.3);});
test('duplicate identical reads are removed; conflicting ones fail',()=>{const start=Date.parse('2026-01-01T00:00:00Z');const r=normalizeRecords([{start,kwh:1},{start,kwh:1}]);assert.equal(r.duplicates,1);assert.throws(()=>normalizeRecords([{start,kwh:1},{start,kwh:2}]),/Conflicting/);});
test('negative use, missing kWh, EV greater than household, and wrong durations fail',()=>{assert.throws(()=>normalizeRecords([{start:0,kwh:-1}]),/non-negative/);assert.throws(()=>normalizeRecords([{start:0,kwh:1,ev:2}]),/exceed/);assert.throws(()=>recordsFromCSV(parseCSV('start,kwh\n2026-01-01T00:00:00Z,\n'),{start:'start',kwh:'kwh'}),/Missing/);assert.throws(()=>recordsFromCSV(parseCSV('start,end,kwh\n2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,1'),{start:'start',end:'end',kwh:'kwh'}),/30-minute/);});
test('OVO discounts only EV energy; requires household quote and measured EV split',()=>{const ovo={...tariffs.find(t=>t.id==='ovo'),day:30,standing:50};const r=simulate(config,ovo,true);near(r.total,(8000-2400)*.3+2400*.1333+365*.5);assert.equal(priceRecords(day('2026-01-01','2026-01-02'),ovo),null);});
test('measured shift conserves energy and respects power limits',()=>{const records=day('2026-09-01','2026-09-03',.2).map(r=>({...r,ev:r.date==='2026-09-01'&&r.minute===1080?3:0,kwh:r.kwh+(r.date==='2026-09-01'&&r.minute===1080?3:0)}));const shifted=shiftEV(records,evTariff,config);near(sum(shifted.records.map(r=>r.kwh)),sum(records.map(r=>r.kwh)));near(shifted.unshifted,0);assert.ok(shifted.records.every(r=>r.ev<=3.5));assert.ok(priceRecords(shifted.records,evTariff).total<priceRecords(records,evTariff).total);});
test('unavailable charging capacity preserves unshifted consumption',()=>{const records=normalizeRecords([{start:parseTimestamp('2026-09-01T18:00:00+01:00'),kwh:10,ev:9}]).records;const s=shiftEV(records,evTariff,{...config,power:1});near(sum(s.records.map(r=>r.kwh)),10);near(s.unshifted,8.5);});
test('bill reconstruction applies historical VAT and line rounding',()=>{near(billCost(1000,30,20,40,5),222.6);near(billCost(123.45,30,23.456,45.678,5),44.79);});
test('invalid annual EV share and impossible charger capacity are rejected',()=>{assert.throws(()=>simulate({...config,evKwh:9000},flat),/within total/);assert.throws(()=>simulate({...config,power:.1},evTariff),/capacity/);});
test('incomplete quote is not assigned a made-up household cost',()=>{assert.equal(simulate(config,tariffs.find(t=>t.id==='ovo')),null);});

test('reading export round-trips with or without the optional EV column',()=>{
 for(const withEV of [false,true]){const original=normalizeRecords([{start:parseTimestamp('2026-09-01T00:00:00+01:00'),kwh:.5,...(withEV?{ev:.2}:{})}]).records;
 const csv=recordsToCSV(original),parsed=parseCSV(csv);assert.equal(parsed.headers.includes('ev_kwh'),withEV);
 const imported=recordsFromCSV(parsed,{start:'interval_start',kwh:'consumption_kwh',...(withEV?{ev:'ev_kwh'}:{})}).records;assert.deepEqual(imported,original);}
});

test('CSV excludes explicitly missing readings but keeps genuine zero use',()=>{
 const csv='interval_start,consumption_kwh,quality,status\n2026-09-01T00:00:00+01:00,0,measured,\n2026-09-01T00:30:00+01:00,0,Missing,\n2026-09-01T01:00:00+01:00,,measured,unavailable\n2026-09-01T01:30:00+01:00,0.5,,\n';
 const result=recordsFromCSV(parseCSV(csv),{start:'interval_start',kwh:'consumption_kwh'});
 assert.equal(result.skippedMissing,2);
 assert.deepEqual(result.records.map(r=>r.kwh),[0,.5]);
 assert.equal(dataStats(result.records).missing,46);
});

test('a file containing only unavailable data cannot replace existing readings',()=>{
 const csv='interval_start,consumption_kwh,status\n2026-09-01T00:00:00+01:00,,null\n';
 assert.throws(()=>recordsFromCSV(parseCSV(csv),{start:'interval_start',kwh:'consumption_kwh'}),/No available readings/);
});
