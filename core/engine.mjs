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
export function rateAt(tariff,minute) {if(tariff.type==='bands')return tariff.bands[tariff.slots[Math.floor(minute/30)%48]].rate;return tariff.type==='tou'&&inWindow(minute,tariff.start,tariff.end)?tariff.night:tariff.day;}
const unpriced=t=>t.standing==null||(t.type!=='bands'&&t.day==null);
const hhmm=m=>`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
// 'HH:MM' UK local clock time on a half-hour boundary -> minutes after midnight.
export function clockMinutes(value) {
 const m=String(value??'').match(/^(\d\d):(\d\d)$/);
 if(!m||Number(m[1])>23||!['00','30'].includes(m[2]))throw Error(`Use a time from 00:00 to 23:30 on the hour or half-hour, not “${value??''}”.`);
 return Number(m[1])*60+Number(m[2]);
}
function pence(value,label) {if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>200)throw Error(`${label} must be between 0 and 200p.`);return value;}
// Validate a custom tariff {id,name,standingChargePencePerDay,bands:[{name,ratePencePerKWh,windows:[{start,end}]}]}.
// Windows are UK local time, end exclusive, wrapping midnight when end < start. A band without windows covers all other times.
export function compileTariff(def) {
 const name=typeof def?.name==='string'?def.name.trim():'';if(!name||name.length>80)throw Error('Give the tariff a name of up to 80 characters.');
 // Supplier is optional for entries saved before it existed; a supplied value must be a short string.
 const rawSupplier=def.supplier??'';if(typeof rawSupplier!=='string'||rawSupplier.trim().length>80)throw Error('Give the supplier a name of up to 80 characters.');const supplier=rawSupplier.trim();
 const standing=pence(def.standingChargePencePerDay,'The standing charge');
 if(!Array.isArray(def.bands)||!def.bands.length||def.bands.length>6)throw Error('Add between one and six rate bands.');
 const slots=Array(48).fill(-1),names=new Set();let fallback=-1;
 const bands=def.bands.map((b,i)=>{
  const label=typeof b?.name==='string'?b.name.trim():'';if(!label||label.length>40)throw Error(`Give band ${i+1} a name of up to 40 characters.`);
  if(names.has(label.toLowerCase()))throw Error(`Use a different name for each band; “${label}” appears twice.`);names.add(label.toLowerCase());
  const rate=pence(b.ratePencePerKWh,`The ${label} rate`);
  if(!Array.isArray(b.windows)||b.windows.length>8)throw Error(`${label} can have up to eight time windows.`);
  if(!b.windows.length){if(fallback>=0)throw Error(`Only one band can cover all other times; ${def.bands[fallback].name.trim()} and ${label} both do.`);fallback=i;}
  const windows=b.windows.map(w=>{const start=clockMinutes(w?.start),end=clockMinutes(w?.end);
   if(start===end)throw Error(`${label}: choose different start and end times. Use “all other times” for a whole-day band.`);
   for(let k=0;k<48;k++)if(inWindow(k*30,start,end)){if(slots[k]>=0)throw Error(slots[k]===i?`${label} has overlapping windows at ${hhmm(k*30)}–${hhmm(k*30+30)}.`:`${def.bands[slots[k]].name.trim()} and ${label} both cover ${hhmm(k*30)}–${hhmm(k*30+30)}.`);slots[k]=i;}
   return {start,end};});
  return {name:label,rate,windows,fallback:!b.windows.length};
 });
 const gap=slots.indexOf(-1);
 if(fallback>=0){if(gap<0)throw Error(`${bands[fallback].name} (all other times) covers no time. Remove it or shorten the other windows.`);for(let k=0;k<48;k++)if(slots[k]<0)slots[k]=fallback;}
 else if(gap>=0){let end=gap;while(end<48&&slots[end]<0)end++;throw Error(`No band covers ${hhmm(gap*30)}–${hhmm(end*30)}. Add a window or mark a band as all other times.`);}
 const rates=bands.map(b=>b.rate),cheapRate=Math.min(...rates)<Math.max(...rates)?Math.min(...rates):null;
 return {id:String(def.id??''),supplier,name,type:'bands',custom:true,standing,bands,slots,cheapRate,ev:compileEV(def.ev,bands),def};
}
// Optional EV charging rate {ratePencePerKWh,windows?:[{start,end}],dailyCapKWh?}. It prices car kWh only. Windows follow band
// rules but are independent of the bands; none means any time the car charges. The cap is kWh per UK local calendar day.
function compileEV(raw,bands) {
 if(raw==null)return null;
 if(typeof raw!=='object'||Array.isArray(raw))throw Error('The EV charging settings are not valid.');
 const rate=pence(raw.ratePencePerKWh,'The EV charging rate'),list=raw.windows===undefined?[]:raw.windows;
 if(!Array.isArray(list)||list.length>8)throw Error('EV charging can have up to eight time windows.');
 const slots=Array(48).fill(false);
 const windows=list.map(w=>{const start=clockMinutes(w?.start),end=clockMinutes(w?.end);
  if(start===end)throw Error('EV charging: choose different start and end times. Leave the times empty to apply the rate whenever the car charges.');
  for(let k=0;k<48;k++)if(inWindow(k*30,start,end)){if(slots[k])throw Error(`EV charging has overlapping windows at ${hhmm(k*30)}–${hhmm(k*30+30)}.`);slots[k]=true;}
  return {start,end};});
 const anyTime=!windows.length;if(anyTime)slots.fill(true);
 let cap=null;if(raw.dailyCapKWh!=null){cap=raw.dailyCapKWh;if(typeof cap!=='number'||!Number.isFinite(cap)||cap<.1||cap>200)throw Error('Set the EV daily cap between 0.1 and 200 kWh, or leave it blank for no cap.');}
 if(bands.some(b=>b.name.toLowerCase()==='ev charging'))throw Error('“EV charging” is used for the EV rate. Give the band another name.');
 return {rate,windows,slots,anyTime,cap};
}
const ALL_SLOTS=Array(48).fill(true);
// EV pricing for any tariff: a custom EV rate, or a published EV-only rate that applies whenever the car charges. Null otherwise.
export function evPricing(tariff) {
 if(tariff.type==='bands')return tariff.ev||null;
 if(tariff.type==='ev-only'&&Number.isFinite(tariff.night))return {rate:tariff.night,slots:ALL_SLOTS,anyTime:true,cap:null,windows:[]};
 return null;
}
// Rate for car kWh at a local minute: the EV rate inside its windows, otherwise the band rate.
export function carRateAt(tariff,minute) {const e=evPricing(tariff);return e&&e.slots[Math.floor(minute/30)%48]?e.rate:rateAt(tariff,minute);}
// EV-rated kWh per chronological item {date,minute,ev}: car kWh inside the EV windows, up to the daily cap per local date.
// Car kWh outside the windows or over the cap is left to the band rate. All zero without EV pricing.
export function evSplit(items,tariff) {
 const e=evPricing(tariff),out=items.map(()=>0);if(!e)return out;let date,used=0;
 items.forEach((r,i)=>{const ev=r.ev??0;if(!(ev>0)||!e.slots[Math.floor(r.minute/30)%48])return;if(r.date!==date){date=r.date;used=0;}
  const v=e.cap==null?ev:Math.max(0,Math.min(ev,e.cap-used));used+=v;out[i]=v;});
 return out;
}
// Uniform band view of any priced tariff (flat, tou or custom bands). Null for EV-only or unpriced tariffs.
export function tariffBands(tariff) {
 if(tariff.type==='ev-only'||unpriced(tariff))return null;
 const all=Array.from({length:48},(_,k)=>k*30);
 if(tariff.type==='bands')return tariff.bands.map((b,i)=>({name:b.name,rate:b.rate,slots:tariff.slots.map(s=>s===i)}));
 if(tariff.type==='tou'){const cheap=all.map(m=>inWindow(m,tariff.start,tariff.end));return [{name:'Cheap window',rate:tariff.night,slots:cheap},{name:'Rest of day',rate:tariff.day,slots:cheap.map(x=>!x)}];}
 return [{name:'All day',rate:tariff.day,slots:all.map(()=>true)}];
}
// Contiguous rate steps across one local day [{start,end,name,rate}] in minutes, end exclusive. Null when tariffBands is null.
export function rateSteps(tariff) {
 const bands=tariffBands(tariff);if(!bands)return null;const steps=[];
 for(let k=0;k<48;k++){const i=bands.findIndex(b=>b.slots[k]),last=steps.at(-1);
  if(last&&last.band===i)last.end=(k+1)*30;else steps.push({band:i,start:k*30,end:(k+1)*30,name:bands[i].name,rate:bands[i].rate});}
 return steps.map(({band,...s})=>s);
}
// Merged local-time windows per band from the 48-slot map: [{name,rate,windows:[{start,end}]}] in minutes, end exclusive and
// taken mod 1440, so a run across midnight is one window with start>end. A whole-day band is {start:0,end:1440}. Null when tariffBands is null.
export function bandWindows(tariff) {
 const bands=tariffBands(tariff);if(!bands)return null;
 return bands.map(b=>{const s=b.slots;if(s.every(Boolean))return {name:b.name,rate:b.rate,windows:[{start:0,end:1440}]};
  // Scan from just after a slot outside the band so a run that crosses midnight is never split.
  const gap=s.indexOf(false),windows=[];let run=null;
  for(let n=1;n<=48;n++){const k=(gap+n)%48;if(s[k]){if(run)run.end=(k+1)*30%1440;else run={start:k*30,end:(k+1)*30%1440};}else if(run){windows.push(run);run=null;}}
  return {name:b.name,rate:b.rate,windows:windows.sort((a,c)=>a.start-c.start)};});
}
// Each band's share of kWh and of unit cost from a breakdown ({bands:[{kwh,cost}]}). Shares are fractions; the
// whole-percent figures use largest-remainder rounding so they add up to exactly 100 whenever the total is positive.
export function bandShares(breakdown) {
 const bands=breakdown?.bands||[],kwh=sum(bands.map(b=>b.kwh)),cost=sum(bands.map(b=>b.cost));
 const pct=(values,total)=>{if(!(total>0))return values.map(()=>0);const raw=values.map(v=>v/total*100),out=raw.map(Math.floor);
  const order=raw.map((v,i)=>[v-out[i],i]).sort((a,b)=>b[0]-a[0]||a[1]-b[1]);for(let r=100-sum(out),j=0;r>0;r--,j++)out[order[j][1]]++;return out;};
 const kp=pct(bands.map(b=>b.kwh),kwh),cp=pct(bands.map(b=>b.cost),cost);
 return bands.map((b,i)=>({...b,kwhShare:kwh>0?b.kwh/kwh:0,costShare:cost>0?b.cost/cost:0,kwhPct:kp[i],costPct:cp[i]}));
}
// Measured cost split by band and by UK local calendar month. Totals match priceRecords. With an EV rate and an EV kWh column,
// a final {name:'EV charging',ev:true} entry holds the EV-rated car kWh; evApplied is false when the readings have no EV column.
export function costBreakdown(records,tariff) {
 const bands=tariffBands(tariff);if(!bands||!records.length)return null;const stats=dataStats(records);
 const e=evPricing(tariff),split=e&&stats.hasEV?evSplit(records,tariff):null,E=bands.length;
 const slotBand=Array.from({length:48},(_,k)=>bands.findIndex(b=>b.slots[k]));
 const blank=()=>[...bands.map(b=>({name:b.name,kwh:0,cost:0})),...(split?[{name:'EV charging',ev:true,kwh:0,cost:0}]:[])],months=new Map();
 for(let d=stats.start;d<=stats.end;d=addDate(d,1)){const m=d.slice(0,7);if(!months.has(m))months.set(m,{month:m,days:0,kwh:0,energy:0,bands:blank()});months.get(m).days++;}
 const totals=blank();let energy=0;
 records.forEach((r,n)=>{const i=slotBand[Math.floor(r.minute/30)],rate=bands[i].rate,evr=split?split[n]:0,m=months.get(r.date.slice(0,7));
  // The record cost is computed exactly as in priceRecords so the totals are identical, not merely close.
  const kwh=r.kwh-evr,cost=kwh*rate/100,evCost=evr*(e?.rate??0)/100,all=evr?(kwh*rate+evr*e.rate)/100:r.kwh*rate/100;
  energy+=all;m.kwh+=r.kwh;m.energy+=all;totals[i].kwh+=kwh;totals[i].cost+=cost;m.bands[i].kwh+=kwh;m.bands[i].cost+=cost;
  if(split){totals[E].kwh+=evr;totals[E].cost+=evCost;m.bands[E].kwh+=evr;m.bands[E].cost+=evCost;}});
 const standing=tariff.standing*stats.days/100;
 return {kwh:stats.kwh,days:stats.days,energy,standing,total:energy+standing,bands:totals.map((b,i)=>({...b,rate:i<E?bands[i].rate:e.rate})),
  months:[...months.values()].map(m=>({...m,standing:tariff.standing*m.days/100,total:m.energy+tariff.standing*m.days/100})),evApplied:e?!!split:undefined};
}
// Annual-simulation equivalent of costBreakdown, from the modelled 48-slot day of simulate(). Band costs sum to p.energy.
export function simulatedBreakdown(tariff,p) {
 const bands=tariffBands(tariff);if(!bands||!p)return null;const e=evPricing(tariff),er=p.evRatedProfile||Array(48).fill(0);
 const out=bands.map(b=>{const kwh=sum(p.profile.map((v,i)=>b.slots[i]?v-er[i]:0))*365;return {name:b.name,rate:b.rate,kwh,cost:kwh*b.rate/100};});
 if(e){const kwh=sum(er)*365;out.push({name:'EV charging',ev:true,rate:e.rate,kwh,cost:kwh*e.rate/100});}
 return {kwh:p.kwh,days:365,energy:p.energy,standing:p.standing,total:p.total,bands:out,evApplied:e?true:undefined};
}
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
 if(unpriced(tariff))return null;
 const stats=dataStats(records);if(!stats)return null;
 // EV-only discounts need the EV split. A custom EV rate without it prices every kWh at the household bands (evApplied false).
 if(tariff.type==='ev-only'&&!stats.hasEV)return null;
 const e=evPricing(tariff),split=e&&stats.hasEV?evSplit(records,tariff):null;let cheapKwh=0,evKwh=0;
 const energy=sum(records.map((r,i)=>{const rate=rateAt(tariff,r.minute),evr=split?split[i]:0,kwh=r.kwh-evr;evKwh+=evr;
  if(tariff.type==='tou'&&rate===tariff.night||tariff.type==='bands'&&rate===tariff.cheapRate)cheapKwh+=kwh;cheapKwh+=evr;
  return evr?(kwh*rate+evr*e.rate)/100:r.kwh*rate/100;}));
 return Number.isFinite(energy)?{energy,standing:tariff.standing*(days??stats.days)/100,total:energy+tariff.standing*(days??stats.days)/100,cheapKwh,kwh:stats.kwh,evKwh,evApplied:e?!!split:undefined}:null;
}
function availableSlots(arrival,departure) {const a=Math.round(arrival/30)%48;return Array.from({length:48},(_,i)=>(a+i)%48).filter(i=>inWindow(i*30,arrival,departure));}
function allocate(amount,slots,power) {const a=Array(48).fill(0);for(const i of slots){const v=Math.min(amount,power/2);a[i]+=v;amount-=v;if(amount<1e-9)break;}return {profile:a,remaining:Math.max(0,amount)};}
export function simulate(config,tariff,shift=false) {
 const {annualKwh,evKwh,homeNightShare,power,arrival,departure}=config;
 if(![annualKwh,evKwh,homeNightShare,power,arrival,departure].every(Number.isFinite)||annualKwh<=0||evKwh<0||evKwh>annualKwh||power<=0||homeNightShare<0||homeNightShare>1||arrival===departure)throw Error('Check annual use, EV use, night share, power and charging hours. EV use must be within total consumption.');
 if(unpriced(tariff))return null;
 const home=(annualKwh-evKwh)/365,ev=evKwh/365;
 const base=Array.from({length:48},(_,i)=>inWindow(i*30,1380,360)?home*homeNightShare/14:home*(1-homeNightShare)/34);
 // Overnight charging fills the cheapest car rate first, then the cheapest band rate; the stable sort keeps arrival order on ties.
 let slots=availableSlots(arrival,departure);if(shift)slots=slots.slice().sort((a,b)=>carRateAt(tariff,a*30)-carRateAt(tariff,b*30)||rateAt(tariff,a*30)-rateAt(tariff,b*30));
 const charge=allocate(ev,slots,power);if(charge.remaining>1e-7)throw Error('The estimated EV use exceeds the charging window’s capacity. Increase power or plug-in time.');
 // The steady-state day is walked from 00:00 to 23:30, which is one local calendar day for the EV daily cap.
 const e=evPricing(tariff),evRated=evSplit(charge.profile.map((v,i)=>({date:'day',minute:i*30,ev:v})),tariff);
 const profile=base.map((v,i)=>v+charge.profile[i]);let cheap=0,evCost=0;
 const energy=sum(profile.map((v,i)=>{const rate=rateAt(tariff,i*30),evr=evRated[i],kwh=base[i]+(charge.profile[i]-evr);
  if(tariff.type==='tou'&&inWindow(i*30,tariff.start,tariff.end)||tariff.type==='bands'&&rate===tariff.cheapRate)cheap+=kwh;cheap+=evr;
  evCost+=evr?(charge.profile[i]-evr)*rate+evr*e.rate:charge.profile[i]*rate;
  return evr?(kwh*rate+evr*e.rate)/100:v*rate/100;}))*365;
 return {energy,standing:365*tariff.standing/100,total:energy+365*tariff.standing/100,cheapKwh:cheap*365,kwh:annualKwh,profile,evProfile:charge.profile,
  evRatedProfile:evRated,evCost:evCost*365/100,...(e?{evApplied:true}:{})};
}
export function shiftEV(records,tariff,{arrival,departure,power}) {
 if(!records.every(r=>r.ev!==undefined))throw Error('Add an EV kWh column from charger history to shift measured EV consumption.');
 const result=records.map(r=>({...r,kwh:r.kwh-r.ev,ev:0}));const groups=new Map();
 const key=r=>r.minute<departure?addDate(r.date,-1):r.date;
 records.forEach((r,i)=>{const k=key(r);if(!groups.has(k))groups.set(k,{indices:[],energy:0,original:[]});const g=groups.get(k);if(inWindow(r.minute,arrival,departure))g.indices.push(i);g.energy+=r.ev;g.original.push(i);});
 let unshifted=0;
 for(const g of groups.values()){let remaining=g.energy;g.indices.sort((a,b)=>carRateAt(tariff,records[a].minute)-carRateAt(tariff,records[b].minute)||rateAt(tariff,records[a].minute)-rateAt(tariff,records[b].minute)||records[a].start-records[b].start);
  for(const i of g.indices){const kwh=Math.min(remaining,power/2);result[i].kwh+=kwh;result[i].ev+=kwh;remaining-=kwh;if(remaining<1e-9)break;}
  if(remaining>1e-9){unshifted+=remaining;for(const i of g.original){const kwh=remaining*records[i].ev/g.energy;result[i].kwh+=kwh;result[i].ev+=kwh;}}
 }
 return {records:result,unshifted};
}
export function billCost(kwh,days,unitExVat,standingExVat,vat) {const round=x=>Math.round((x+Number.EPSILON)*100)/100;return round((round(kwh*unitExVat/100)+round(days*standingExVat/100))*(1+vat/100));}
// Savings are measured against baselineId priced at current timing, falling back to edf-standard, then the first priced tariff.
export function compare(config,records,tariffs,shift=false,baselineId='edf-standard') {
 const stats=dataStats(records),price=t=>records.length?priceRecords(records,t):simulate(config,t,false);let baseline,base;
 for(const t of [tariffs.find(t=>t.id===baselineId),tariffs.find(t=>t.id==='edf-standard'),...tariffs]){if(!t)continue;const p=price(t);if(p){baseline=t;base=p;break;}}
 if(!baseline)throw Error('Enter rates for at least one tariff to compare.');
 return tariffs.map(t=>{let original,optimised,unshifted=0;
  if(records.length){original=priceRecords(records,t);if(stats.hasEV){const s=shiftEV(records,t,config);optimised=priceRecords(s.records,t);unshifted=s.unshifted;}else optimised=original;}
  else{original=simulate(config,t,false);optimised=simulate(config,t,true);}
  const active=shift?optimised:original;return {...t,original,optimised,active,unshifted,isBaseline:t.id===baseline.id,saving:active?base.total-active.total:null};
 }).sort((a,b)=>(a.active?.total??Infinity)-(b.active?.total??Infinity));
}

export function recordsToCSV(records) {
 const hasEV=records.length>0&&records.every(r=>r.ev!==undefined);
 return 'interval_start,consumption_kwh'+(hasEV?',ev_kwh':'')+'\n'+records.map(r=>`${new Date(r.start).toISOString()},${r.kwh}${hasEV?','+r.ev:''}`).join('\n');
}
