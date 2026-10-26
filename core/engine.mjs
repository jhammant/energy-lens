const HALF_HOUR = 1800000;
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
export const sum = xs => xs.reduce((a,b)=>a+b,0);
export function localParts(value) {
 const p=Object.fromEntries(fmt.formatToParts(new Date(value)).map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
}
export function addDate(date,days) {return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function parseTimestamp(value,zone='offset') {
 const s=String(value).trim();
 if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) { const n=Date.parse(s); if(!Number.isFinite(n))throw Error(`Invalid timestamp: ${s}`); return n; }
 let m=s.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/);
 if(!m) { const uk=s.match(/^(\d\d)\/(\d\d)\/(\d{4})[ T](\d\d):(\d\d)(?::(\d\d))?$/);if(uk)m=[uk[0],uk[3],uk[2],uk[1],uk[4],uk[5],uk[6]]; }
 if(!m)throw Error('Use a full timestamp, for example 2026-09-01T00:00:00+01:00. Cumulative meter readings are not half-hourly consumption.');
 const date=`${m[1]}-${m[2]}-${m[3]}`, minute=Number(m[4])*60+Number(m[5]);
 if(minute>=1440||Number(m[5])>59||Number(m[6]||0)!==0)throw Error(`Invalid half-hour timestamp: ${s}`);
 const base=Date.parse(`${date}T${m[4]}:${m[5]}:00Z`);
 if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,10)!==date)throw Error(`Invalid date: ${s}`);
 if(zone==='UTC')return base;
 if(zone!=='Europe/London')throw Error('These timestamps have no timezone. Choose UTC or UK local time in the import options.');
 const candidates=[base,base-3600000].filter(t=>{const p=localParts(t);return p.date===date&&p.minute===minute;});
 if(candidates.length!==1)throw Error(`Ambiguous or nonexistent UK clock-change time: ${s}. Use timestamps with an explicit UTC offset.`);
 return candidates[0];
}
export const midnight = date => parseTimestamp(date+'T00:00:00','Europe/London');
export function inWindow(minute,start,end) {return start<end?minute>=start&&minute<end:minute>=start||minute<end;}
export function rateAt(tariff,minute) {return tariff.type==='tou'&&inWindow(minute,tariff.start,tariff.end)?tariff.night:tariff.day;}
export function parseCSV(text) {
 text=text.replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0];const delim=first.includes('\t')?'\t':(first.split(';').length>first.split(',').length?';':',');
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===delim&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw Error('The CSV has an unclosed quoted field.');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
 if(rows.length<2)throw Error('The file must contain a header and at least one reading.');
 const headers=rows.shift().map(x=>x.trim());if(new Set(headers).size!==headers.length)throw Error('CSV column names must be unique.');
 return {headers,rows};
}
export function recordsFromCSV(parsed,mapping) {
 const {headers,rows}=parsed;const index=key=>headers.indexOf(mapping[key]);
 if(index('start')<0||index('kwh')<0)throw Error('Choose the timestamp and electricity kWh columns.');
 const quality= headers.map((h,i)=>/^(quality|status)$/i.test(h)?i:-1).filter(i=>i>=0);
 let skippedMissing=0;
 const num=(v,name,i)=>{if(v===undefined||String(v).trim()==='')throw Error(`Missing ${name} on row ${i+2}.`);const n=Number(String(v).replace(/,/g,''));if(!Number.isFinite(n))throw Error(`Invalid ${name} on row ${i+2}.`);return n;};
 const readings=rows.flatMap((row,i)=>{
  if(quality.some(column=>/^(missing|unavailable|null)$/i.test(String(row[column]??'').trim()))){skippedMissing++;return [];}
  let start=row[index('start')];if(index('time')>=0)start+=' '+row[index('time')];
  const r={start:parseTimestamp(start,mapping.zone),kwh:num(row[index('kwh')],'kWh',i)};
  if(index('end')>=0&&parseTimestamp(row[index('end')],mapping.zone)-r.start!==HALF_HOUR)throw Error(`Row ${i+2} is not a 30-minute consumption interval.`);
  if(index('ev')>=0)r.ev=num(row[index('ev')],'EV kWh',i);return [r];
 });
 if(!readings.length)throw Error('No available readings in this file. Missing rows are not imported.');
 return {...normalizeRecords(readings),skippedMissing};
}
export function normalizeRecords(records) {
 if(!Array.isArray(records)||records.length>100000)throw Error('Import up to 100,000 half-hourly readings at a time.');
 let duplicates=0;const map=new Map();
 for(const r of records){const start=typeof r.start==='number'?r.start:parseTimestamp(r.start);const kwh=Number(r.kwh);const ev=r.ev==null?undefined:Number(r.ev);
  if(!Number.isFinite(start)||start%HALF_HOUR!==0)throw Error('Every reading must start on a 00 or 30 minute boundary.');
  if(!Number.isFinite(kwh)||kwh<0||!Number.isFinite(ev??0)||(ev??0)<0||(ev??0)>kwh+1e-8)throw Error('Consumption must be non-negative; EV kWh cannot exceed whole-home kWh.');
  if(map.has(start)){const prior=map.get(start);if(Math.abs(prior.kwh-kwh)>1e-9||(prior.ev??null)!==(ev??null))throw Error('Conflicting duplicate timestamps. Check the export and timezone.');duplicates++;continue;}
  map.set(start,{start,kwh,...(ev!==undefined?{ev}:{}),...localParts(start)});
 }
 const result=[...map.values()].sort((a,b)=>a.start-b.start);return {records:result,duplicates};
}
export function dataStats(records) {
 if(!records.length)return null;const start=records[0].date,end=records.at(-1).date;
 const expected=(midnight(addDate(end,1))-midnight(start))/HALF_HOUR;
 const days=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
 return {start,end,days,expected,missing:expected-records.length,coverage:records.length/expected,kwh:sum(records.map(r=>r.kwh)),ev:sum(records.map(r=>r.ev??0)),hasEV:records.every(r=>r.ev!==undefined)};
}
export function priceRecords(records,tariff,days) {
 if(tariff.day===null||tariff.standing===null)return null;
 const stats=dataStats(records);if(!stats)return null;let cheapKwh=0;
 const energy=sum(records.map(r=>{const rate=rateAt(tariff,r.minute);if(tariff.type==='tou'&&rate===tariff.night)cheapKwh+=r.kwh;
  if(tariff.type==='ev-only'){if(!stats.hasEV)return NaN;cheapKwh+=r.ev;return ((r.kwh-r.ev)*tariff.day+r.ev*tariff.night)/100;}return r.kwh*rate/100;}));
 return Number.isFinite(energy)?{energy,standing:tariff.standing*(days??stats.days)/100,total:energy+tariff.standing*(days??stats.days)/100,cheapKwh,kwh:stats.kwh}:null;
}
function availableSlots(arrival,departure) {const a=Math.round(arrival/30)%48;return Array.from({length:48},(_,i)=>(a+i)%48).filter(i=>inWindow(i*30,arrival,departure));}
function allocate(amount,slots,power) {const a=Array(48).fill(0);for(const i of slots){const v=Math.min(amount,power/2);a[i]+=v;amount-=v;if(amount<1e-9)break;}return {profile:a,remaining:Math.max(0,amount)};}
export function simulate(config,tariff,shift=false) {
 const {annualKwh,evKwh,homeNightShare,power,arrival,departure}=config;
 if(![annualKwh,evKwh,homeNightShare,power,arrival,departure].every(Number.isFinite)||annualKwh<=0||evKwh<0||evKwh>annualKwh||power<=0||homeNightShare<0||homeNightShare>1||arrival===departure)throw Error('Check annual use, EV use, night share, power and charging hours. EV use must be within total consumption.');
 if(tariff.day===null||tariff.standing===null)return null;
 const home=(annualKwh-evKwh)/365,ev=evKwh/365;
 const base=Array.from({length:48},(_,i)=>inWindow(i*30,1380,360)?home*homeNightShare/14:home*(1-homeNightShare)/34);
 let slots=availableSlots(arrival,departure);if(shift)slots=slots.slice().sort((a,b)=>rateAt(tariff,a*30)-rateAt(tariff,b*30));
 const charge=allocate(ev,slots,power);if(charge.remaining>1e-7)throw Error('The estimated EV use exceeds the charging window’s capacity. Increase power or plug-in time.');
 const profile=base.map((v,i)=>v+charge.profile[i]);let cheap=0;
 const energy=sum(profile.map((v,i)=>{if(tariff.type==='ev-only'){cheap+=charge.profile[i];return (base[i]*tariff.day+charge.profile[i]*tariff.night)/100;}
  const rate=rateAt(tariff,i*30);if(tariff.type==='tou'&&inWindow(i*30,tariff.start,tariff.end))cheap+=v;return v*rate/100;}))*365;
 return {energy,standing:365*tariff.standing/100,total:energy+365*tariff.standing/100,cheapKwh:cheap*365,kwh:annualKwh,profile,evProfile:charge.profile};
}
export function shiftEV(records,tariff,{arrival,departure,power}) {
 if(!records.every(r=>r.ev!==undefined))throw Error('Add an EV kWh column from charger history to shift measured EV consumption.');
 const result=records.map(r=>({...r,kwh:r.kwh-r.ev,ev:0}));const groups=new Map();
 const key=r=>r.minute<departure?addDate(r.date,-1):r.date;
 records.forEach((r,i)=>{const k=key(r);if(!groups.has(k))groups.set(k,{indices:[],energy:0,original:[]});const g=groups.get(k);if(inWindow(r.minute,arrival,departure))g.indices.push(i);g.energy+=r.ev;g.original.push(i);});
 let unshifted=0;
 for(const g of groups.values()){let remaining=g.energy;g.indices.sort((a,b)=>rateAt(tariff,records[a].minute)-rateAt(tariff,records[b].minute)||records[a].start-records[b].start);
  for(const i of g.indices){const kwh=Math.min(remaining,power/2);result[i].kwh+=kwh;result[i].ev+=kwh;remaining-=kwh;if(remaining<1e-9)break;}
  if(remaining>1e-9){unshifted+=remaining;for(const i of g.original){const kwh=remaining*records[i].ev/g.energy;result[i].kwh+=kwh;result[i].ev+=kwh;}}
 }
 return {records:result,unshifted};
}
export function billCost(kwh,days,unitExVat,standingExVat,vat) {const round=x=>Math.round((x+Number.EPSILON)*100)/100;return round((round(kwh*unitExVat/100)+round(days*standingExVat/100))*(1+vat/100));}
export function compare(config,records,tariffs,shift=false) {
 const baseline=tariffs.find(t=>t.id==='edf-standard');const stats=dataStats(records);const base=records.length?priceRecords(records,baseline):simulate(config,baseline,false);
 return tariffs.map(t=>{let original,optimised,unshifted=0;
  if(records.length){original=priceRecords(records,t);if(stats.hasEV){const s=shiftEV(records,t,config);optimised=priceRecords(s.records,t);unshifted=s.unshifted;}else optimised=original;}
  else{original=simulate(config,t,false);optimised=simulate(config,t,true);}
  const active=shift?optimised:original;return {...t,original,optimised,active,unshifted,saving:active?base.total-active.total:null};
 }).sort((a,b)=>(a.active?.total??Infinity)-(b.active?.total??Infinity));
}

export function recordsToCSV(records) {
 const hasEV=records.length>0&&records.every(r=>r.ev!==undefined);
 return 'interval_start,consumption_kwh'+(hasEV?',ev_kwh':'')+'\n'+records.map(r=>`${new Date(r.start).toISOString()},${r.kwh}${hasEV?','+r.ev:''}`).join('\n');
}
