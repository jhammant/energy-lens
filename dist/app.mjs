import {tariffs as published,checkedOn} from './tariffs.mjs';
import {parseCSV,recordsFromCSV,normalizeRecords,dataStats,compare,simulate,shiftEV,localParts,billCost,rateAt,recordsToCSV,compileTariff,costBreakdown,simulatedBreakdown,rateSteps,bandWindows,bandShares,evPricing,evSplit} from './engine.mjs';
const $=id=>document.getElementById(id), money=x=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(x), precise=x=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(x), number=x=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:1}).format(x), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=m=>`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const minute=s=>{const [h,m]=s.split(':').map(Number);return h*60+m;};
const defaults={annualKwh:8000,evKwh:2400,homeNightShare:.25,power:7,arrival:1080,departure:420,overhead:0};
let state={schema:'energy-lens-v1',config:{...defaults},records:[],bills:[],overrides:{},customTariffs:[],basis:'model',shift:true,selected:'edf-18',baseline:'edf-standard'}, importedDefaults={...defaults}, pendingCSV, editingId, editingCustom, resultRows=[];
const MAX_CUSTOM=20;
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function persist(){try{localStorage.setItem('energy-lens-v1',JSON.stringify(state));}catch{toast('Browser storage is full. Download a private backup to keep your readings.');}}
function tariffs(){return published.map(t=>({...t,...state.overrides[t.id]}));}
function allTariffs(){return [...tariffs(),...state.customTariffs.map(compileTariff)];}
// Rebuild custom tariffs from whitelisted keys so a backup cannot inject other fields; drop anything that fails validation.
function readCustom(list){const out=[];if(!Array.isArray(list))return out;
 for(const d of list){if(out.length>=MAX_CUSTOM)break;const id=String(d?.id??'');if(!/^custom-[a-z0-9]{1,24}$/.test(id)||out.some(t=>t.id===id))continue;
  const def={id,...(d.supplier!==undefined?{supplier:d.supplier}:{}),name:d.name,standingChargePencePerDay:d.standingChargePencePerDay,bands:Array.isArray(d.bands)?d.bands.map(b=>({name:b?.name,ratePencePerKWh:b?.ratePencePerKWh,windows:Array.isArray(b?.windows)?b.windows.map(w=>({start:w?.start,end:w?.end})):null})):null,...readEV(d.ev)};
  try{compileTariff(def);out.push(def);}catch{}}
 return out;}
// Optional EV rate: absent stays absent; a plain object keeps only its known keys; anything else is passed on so validation drops the tariff.
function readEV(ev){if(ev==null)return {};if(typeof ev!=='object'||Array.isArray(ev))return {ev};
 return {ev:{ratePencePerKWh:ev.ratePencePerKWh,...(ev.windows===undefined?{}:{windows:Array.isArray(ev.windows)?ev.windows.map(w=>({start:w?.start,end:w?.end})):null}),...(ev.dailyCapKWh!=null?{dailyCapKWh:ev.dailyCapKWh}:{})}};}
const tariffLabel=t=>t.supplier?`${t.supplier} ${t.name}`:t.name;
const spans=ws=>ws.map(w=>clock(w.start)+'–'+clock(w.end)).join(', ');
const capText=e=>e.cap!=null?`up to ${number(e.cap)} kWh a day`:'';
const bandText=t=>t.bands.map(b=>`${b.name} ${b.rate}p ${b.fallback?'all other times':spans(b.windows)}`).join('; ')
 +(t.ev?`; EV charging ${t.ev.rate}p ${t.ev.anyTime?'any time':spans(t.ev.windows)}${t.ev.cap!=null?', '+capText(t.ev):''}`:'');
function validConfig(config){const c={...defaults};for(const k of Object.keys(c))if(Number.isFinite(Number(config?.[k])))c[k]=Number(config[k]);return c;}
function readBackup(data){if(data.schema!=='energy-lens-v1')throw Error('This is not an Energy Lens backup. Import a half-hourly CSV instead.');
 const r=normalizeRecords(data.records||[]);const cfg=validConfig(data.config);if(data.config?.annualKwh===undefined&&Number.isFinite(data.annualKwh))cfg.annualKwh=data.annualKwh;
 const overrides={};for(const t of published){if(!data.overrides?.[t.id])continue;const o={};for(const k of ['day','night','standing','start','end']){const v=data.overrides[t.id][k];if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=(['start','end'].includes(k)?1439:200))o[k]=v;}overrides[t.id]=o;}
 const bills=Array.isArray(data.bills)?data.bills.filter(b=>/^\d{4}-\d{2}$/.test(b.month)&&['kwh','electricity','gas','total','unitExVat','standingExVat','vat','days'].every(k=>Number.isFinite(b[k])&&b[k]>=0)):[];
 const customTariffs=readCustom(data.customTariffs);
 return {...state,...data,shift:data.shift!==false,bills,records:r.records,config:cfg,overrides,customTariffs,basis:r.records.length&&data.basis==='actual'?'actual':'model',selected:[...published,...customTariffs].some(t=>t.id===data.selected)?data.selected:'edf-18',
  baseline:typeof data.baseline==='string'&&[...published,...customTariffs].some(t=>t.id===data.baseline)?data.baseline:'edf-standard'};
}
try{const saved=localStorage.getItem('energy-lens-v1');if(saved)state=readBackup(JSON.parse(saved));}catch{toast('The saved data could not be loaded. Import your backup again.');}
importedDefaults=validConfig(state.importedDefaults||state.config);
function controls(){const c=state.config;$('annual-kwh').value=c.annualKwh;$('ev-kwh').value=c.evKwh;$('night-share').value=c.homeNightShare*100;$('power').value=c.power;$('arrival').value=clock(c.arrival);$('departure').value=clock(c.departure);$('overhead').value=c.overhead;$('basis').value=state.basis;}
function readControls(){state.config={annualKwh:Number($('annual-kwh').value),evKwh:Number($('ev-kwh').value),homeNightShare:Number($('night-share').value)/100,power:Number($('power').value),arrival:minute($('arrival').value),departure:minute($('departure').value),overhead:Number($('overhead').value)};persist();render();}
function filtered(){return state.basis==='actual'?state.records.filter(r=>(!state.from||r.date>=state.from)&&(!state.to||r.date<=state.to)):[];}
function showView(view){for(const name of ['compare','usage','data'])$(name+'-view').hidden=name!==view;document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});}
// Chart: usage as a stepped area on one kWh-per-half-hour axis, each half-hour filled with the colour of the selected tariff's rate band.
const CHART={width:760,height:236,padL:44,padR:16,top:40,chartH:150};CHART.bw=(CHART.width-CHART.padL-CHART.padR)/48;CHART.base=CHART.top+CHART.chartH;
let chartModel=null,lastSlot=null;
// Band colours by rate rank, cheapest green to dearest red, with distinct steps between. Every colour is at least 4:1 against white.
const RAMP=['#2f8a4e','#5f8a1f','#8a7a00','#a86b00','#c2540a','#b42318'],RAMP_PICK={1:[],2:[0,5],3:[0,3,5],4:[0,2,4,5],5:[0,1,2,4,5],6:[0,1,2,3,4,5]};
const FLAT_COLOUR='#2860cc',NEUTRAL_HOME='#5b6b82',NEUTRAL_CAR='#167c80';
function bandColours(rates){const r=[...new Set(rates)].sort((a,b)=>a-b),pick=RAMP_PICK[Math.min(6,r.length)];return new Map(r.map((x,k)=>[x,r.length===1?FLAT_COLOUR:RAMP[pick[Math.min(k,pick.length-1)]]]));}
const windowsText=ws=>ws.some(w=>w.end-w.start===1440)?'':ws.map(w=>clock(w.start)+'–'+clock(w.end)).join(', ');
// A custom tariff's own EV charging rate (published EV-only tariffs keep their neutral display). Null otherwise.
const ownEV=t=>t.type==='bands'?evPricing(t):null;
// Colours come from the band rates plus any EV rate, so the EV segment sits on the same cheap-to-dear ramp.
function palette(t,w){const e=ownEV(t);return bandColours([...w.map(b=>b.rate),...(e?[e.rate]:[])]);}
// Bands for the selected tariff with merged windows and colours, in definition order. Null when the tariff has no time-based bands.
function bandView(t){const w=bandWindows(t);if(!w)return null;const colours=palette(t,w);return w.map(b=>({...b,colour:colours.get(b.rate),when:windowsText(b.windows)}));}
// The EV rate row for a custom tariff with an EV charging rate: colour, rate and when it applies.
function evView(t){const e=ownEV(t),w=bandWindows(t);if(!e||!w)return null;
 return {name:'EV charging',ev:true,rate:e.rate,colour:palette(t,w).get(e.rate),when:(e.anyTime?'Any time the car charges':spans(e.windows))+(e.cap!=null?' · '+capText(e):''),cap:e.cap,anyTime:e.anyTime};}
function profileSVG(home,ev,evRated,t){const {width,height,padL,padR,top,chartH,bw,base}=CHART,total=home.map((v,i)=>v+ev[i]),max=Math.max(.1,...total),showEV=ev.some(v=>v>1e-9);
 const steps=rateSteps(t),bands=bandView(t),colourOf=steps?new Map(bands.map(b=>[b.name,b.colour])):null,evv=steps?evView(t):null,evOn=!!evv&&evRated.some(v=>v>1e-9);
 const H=v=>v/max*chartH,f=n=>n.toFixed(2),gap=1.5,bwi=bw-2*gap;
 // Bar segment from y (top) down h px; the topmost segment of a slot gets softly rounded top corners and a square bottom.
 const seg=(x,y,h,round)=>{const r=round?Math.min(3,bwi/2,h):0;return `M${f(x)},${f(y+h)}V${f(y+r)}`+(r?`A${f(r)},${f(r)} 0 0 1 ${f(x+r)},${f(y)}H${f(x+bwi-r)}A${f(r)},${f(r)} 0 0 1 ${f(x+bwi)},${f(y+r)}`:`H${f(x+bwi)}`)+`V${f(y+h)}Z`;};
 let svg=`<svg class="profile-svg" role="img" aria-label="Average day for ${esc(tariffLabel(t))}: usage per half-hour${steps?', coloured by rate band':''}${showEV?`; car charging hatched on top${evOn?`, at the EV rate of ${evv.rate}p/kWh where it applies`:''}`:''}." viewBox="0 0 ${width} ${height}">`;
 svg+=`<defs><pattern id="car-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.4" height="6" fill="#fff" fill-opacity=".6"/></pattern></defs>`;
 // Faint background per rate run so a band stays visible where usage is near zero, with its name above the plot where it fits.
 const runs=steps||[{start:0,end:1440,name:''}];
 if(steps)for(const s of steps){const x0=padL+s.start/30*bw,w=(s.end-s.start)/30*bw;
  svg+=`<rect class="band-bg" data-band="${esc(s.name)}" x="${x0.toFixed(2)}" y="${top}" width="${w.toFixed(2)}" height="${chartH}" fill="${colourOf.get(s.name)}" fill-opacity=".08"/>`;
  if(steps.length>1&&s.name.length*6.4+8<=w)svg+=`<text class="band-label" x="${(x0+w/2).toFixed(2)}" y="${top-8}" text-anchor="middle">${esc(s.name)}</text>`;}
 svg+=`<g class="axis">`;
 for(const k of [0,.5,1]){const yy=(base-k*chartH).toFixed(2);svg+=`<line x1="${padL}" y1="${yy}" x2="${width-padR}" y2="${yy}" stroke="#dfe7ef" stroke-dasharray="3 4"/><text class="${k===.5?'mid-tick':''}" x="${padL-6}" y="${yy}" dy="4" text-anchor="end">${(max*k).toFixed(2)}</text>`;}
 svg+=`<text x="0" y="12">kWh / half-hour</text>`;
 for(const h of [0,6,12,18,24])svg+=`<text x="${padL+h/24*(width-padL-padR)}" y="${base+22}" text-anchor="${h===24?'end':h===0?'start':'middle'}">${String(h).padStart(2,'0')}:00</text>`;
 svg+=`</g>`;
 // One independent bar per half-hour. Home is solid in the slot's band colour; car charging is stacked on top with a white hatch:
 // first any car kWh at the band rate (outside the EV times or over the cap), then car kWh at the EV rate in the EV colour.
 // Only the topmost segment is rounded. Zero-usage slots draw nothing.
 for(const s of runs)for(let i=s.start/30;i<s.end/30;i++){const x=padL+i*bw+gap,band=steps?colourOf.get(s.name):NEUTRAL_HOME,er=evv?evRated[i]:0;
  const parts=[[home[i],'bar-home',band,false],[ev[i]-er,'bar-car',steps?band:NEUTRAL_CAR,true],[er,'bar-car bar-car-ev',evv?.colour,true]].filter(p=>p[0]>1e-9);
  if(!parts.length)continue;let bar='',y=base;
  parts.forEach(([kwh,cls,fill,hatched],k)=>{const h=H(kwh);y-=h;const d=seg(x,y,h,k===parts.length-1);
   bar+=`<path class="${cls}" d="${d}" fill="${fill}"/>`+(hatched?`<path class="bar-car-hatch" d="${d}" fill="url(#car-hatch)"/>`:'');});
  svg+=`<g class="bar" data-slot="${i}" data-band="${esc(s.name)}"${er>1e-9?' data-ev="1"':''}>${bar}</g>`;}
 svg+=`<line id="chart-cursor" class="chart-cursor" x1="0" x2="0" y1="${top}" y2="${base}" visibility="hidden"/><circle id="chart-dot-home" class="chart-dot" r="4" fill="#0e1726" visibility="hidden"/>${showEV?'<circle id="chart-dot-total" class="chart-dot" r="4" fill="#0e1726" visibility="hidden"/>':''}</svg>`;
 chartModel={home,ev,evRated:evv?evRated:home.map(()=>0),e:evv?ownEV(t):null,total,t,steps,showEV,max};
 return svg;
}
// Instant tooltip: handlers are wired once on the persistent #profile-chart container and only read chartModel.
const pence=p=>p<100?`${p.toFixed(1)}p`:precise(p/100);
function slotInfo(i){const {home,ev,evRated,e,total,t,steps,showEV}=chartModel;let rate,cost,evLine='';
 if(t.type==='ev-only'){rate=`Rate home ${t.day}p · car ${t.night}p/kWh`;cost=home[i]*t.day+ev[i]*t.night;}
 else{const r=rateAt(t,i*30),step=steps?.find(s=>i*30>=s.start&&i*30<s.end),er=evRated[i],spill=ev[i]-er;rate=`Rate ${r}p/kWh${step?' · '+step.name:''}`;cost=(total[i]-er)*r+er*(e?.rate??0);
  // Car kWh at the EV rate, and any car kWh left at the band rate because it is outside the EV times or over the daily cap.
  if(e&&ev[i]>1e-9)evLine=!e.slots[i]?`Car outside EV times, at ${r}p/kWh`:(er>1e-9?`EV rate ${e.rate}p/kWh on ${er.toFixed(3)} kWh`:'')+(spill>1e-9?`${er>1e-9?' · ':''}${spill.toFixed(3)} kWh over the daily cap at ${r}p`:'');}
 return {time:`${clock(i*30)}–${clock(i*30+30)}`,usage:`Usage ${total[i].toFixed(3)} kWh`,split:showEV?`Home ${home[i].toFixed(3)} · Car ${ev[i].toFixed(3)}`:'',rate,ev:evLine,cost:`Cost ${pence(cost)}`};}
function showSlot(i,announce=false){if(!chartModel)return;const svg=$('profile-chart').querySelector('svg');if(!svg)return;i=Math.max(0,Math.min(47,i));lastSlot=i;
 const info=slotInfo(i),tip=$('chart-tip'),cx=CHART.padL+(i+.5)*CHART.bw,cy=v=>CHART.base-v/chartModel.max*CHART.chartH;
 svg.querySelector('.bar.active')?.classList.remove('active');svg.querySelector(`.bar[data-slot="${i}"]`)?.classList.add('active');svg.classList.add('hovering');
 const cursor=$('chart-cursor');cursor.setAttribute('x1',cx);cursor.setAttribute('x2',cx);cursor.setAttribute('visibility','visible');
 const dh=$('chart-dot-home');dh.setAttribute('cx',cx);dh.setAttribute('cy',cy(chartModel.home[i]));dh.setAttribute('visibility','visible');
 const dt=$('chart-dot-total');if(dt){dt.setAttribute('cx',cx);dt.setAttribute('cy',cy(chartModel.total[i]));dt.setAttribute('visibility','visible');}
 for(const k of ['time','usage','split','rate','ev','cost']){const el=tip.querySelector('.tip-'+k);el.textContent=info[k];el.hidden=!info[k];}
 tip.hidden=false;
 const wrap=tip.parentElement.getBoundingClientRect(),box=svg.getBoundingClientRect(),px=box.left-wrap.left+cx/CHART.width*box.width,w=tip.offsetWidth;
 let left=px>wrap.width*.6?px-w-12:px+12;left=Math.max(0,Math.min(wrap.width-w,left));tip.style.transform=`translateX(${Math.round(left)}px)`;
 if(announce)$('chart-readout').textContent=Object.values(info).filter(Boolean).join('. ');}
function hideTip(){$('chart-tip').hidden=true;const svg=$('profile-chart').querySelector('svg');svg?.classList.remove('hovering');svg?.querySelector('.bar.active')?.classList.remove('active');for(const id of ['chart-cursor','chart-dot-home','chart-dot-total'])$(id)?.setAttribute('visibility','hidden');}
function slotFromPointer(e){const box=$('profile-chart').querySelector('svg')?.getBoundingClientRect();if(!box?.width)return null;return Math.floor(((e.clientX-box.left)/box.width*CHART.width-CHART.padL)/CHART.bw);}
{const chart=$('profile-chart');
 const onPointer=e=>{const i=slotFromPointer(e);if(i==null)return;if(i<0||i>47)hideTip();else showSlot(i);};
 chart.addEventListener('pointermove',onPointer);chart.addEventListener('pointerdown',onPointer);
 chart.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')hideTip();});
 document.addEventListener('pointerdown',e=>{if(!chart.contains(e.target))hideTip();});
 chart.addEventListener('focus',()=>showSlot(lastSlot??new Date().getHours()*2,true));chart.addEventListener('blur',hideTip);
 chart.addEventListener('keydown',e=>{const step={ArrowLeft:-1,ArrowRight:1}[e.key];
  if(step!=null||e.key==='Home'||e.key==='End'){e.preventDefault();showSlot(e.key==='Home'?0:e.key==='End'?47:(lastSlot??0)+step,true);}else if(e.key==='Escape')hideTip();});}
function render(){
 const allStats=dataStats(state.records),records=filtered(),stats=dataStats(records),isActual=state.basis==='actual';
 $('basis').querySelector('[value=actual]').disabled=!state.records.length;$('date-controls').hidden=!isActual;
 $('night-value').textContent=Math.round(state.config.homeNightShare*100)+'%';$('overhead-value').textContent=state.config.overhead+'%';
 $('annual-source').textContent=state.annualSource||'Illustrative starting value. Import your bill summary or enter your annual electricity use.';
 $('ev-title').textContent=state.tesla?'Tesla '+(state.tesla.model||'home charging'):'Electric car';
 $('ev-source').textContent=state.tesla?`${number(state.tesla.homeKwh)} kWh at home, reported by Tesla. ${state.tesla.period}. Timing and losses are not measured.`:'Example estimate until you enter home charging use. Public charging is excluded.';
 $('input-badge').textContent=state.tesla?'Measured totals, assumed timing':state.bills.length?'Bill total, estimated EV':'Illustrative inputs';
 $('current-mode').textContent=isActual?'Measured timing':'Charge on arrival';
 if(isActual&&!stats?.hasEV)state.shift=false;
 $('shifted-mode').disabled=isActual&&!stats?.hasEV;$('current-mode').setAttribute('aria-pressed',String(!state.shift));$('shifted-mode').setAttribute('aria-pressed',String(state.shift));
 for(const id of ['annual-kwh','ev-kwh','overhead','night-share'])$(id).disabled=isActual;
 $('basis-description').textContent=isActual?(stats?`${stats.start} to ${stats.end}. ${number(stats.kwh)} kWh over ${stats.days} calendar days.`:'No readings in this date range.'):'Annual simulation using your totals and the assumptions alongside.';
 $('scenario-note').textContent=isActual?(stats?.hasEV?'Measured EV consumption can be moved within your plug-in window. Other household use stays in place.':'EV session timing is not available. This view prices the measured whole-house pattern unchanged.'): 'Simulation, not a measured profile. The same energy is used in both scenarios; only the car’s charging time moves.';
 if(allStats){$('status-banner').className='notice '+(allStats.missing?'':'good');$('status-banner').innerHTML=`<p><strong>${number(state.records.length)} half-hourly readings loaded.</strong> ${allStats.missing?`${allStats.missing} intervals are missing. Costs understate use across gaps.`:'All intervals are present across the covered dates.'} Data stays in this browser.</p>`;}
 else{$('status-banner').className='notice';$('status-banner').innerHTML=`<p><strong>${state.meterStatus?'EDF readings are not available yet.':'Start with your own usage.'}</strong> ${esc(state.meterStatus||'Import half-hourly readings or a saved household file. The starting numbers below are examples.')}</p><button id="status-data">View data</button>`;$('status-data').onclick=()=>showView('data');}
 const config={...state.config,evKwh:state.config.evKwh*(1+state.config.overhead/100)};
 try{if(config.arrival<=config.departure)throw Error('Choose an overnight plug-in window, with arrival later in the day than departure.');if(isActual&&!records.length)throw Error('No readings in this date range. Select a covered date range.');
  resultRows=compare(config,records,allTariffs(),state.shift,state.baseline);$('model-error').hidden=true;
 }catch(e){$('model-error').textContent=e.message;$('model-error').hidden=false;$('metrics').innerHTML='';$('tariff-rows').innerHTML='';hideTip();chartModel=null;$('profile-chart').innerHTML='';$('chart-key').hidden=true;$('chart-key').innerHTML='';$('breakdown').innerHTML='';$('breakdown-pane').hidden=true;$('quick-estimate').hidden=true;resultRows=[];renderCustomList();renderUsage();renderData();return;}
 const best=resultRows.find(t=>t.active),baseline=resultRows.find(t=>t.isBaseline),selected=resultRows.find(t=>t.id===state.selected&&t.active)||best;
 // Show the effective baseline when the saved one cannot be priced; the saved choice is kept until the user changes it.
 const priced=resultRows.filter(t=>t.active).sort((a,b)=>Number(!!a.custom)-Number(!!b.custom));
 $('baseline-select').innerHTML=priced.map(t=>`<option value="${esc(t.id)}">${esc(tariffLabel(t))}${t.custom?' (added by you)':''}</option>`).join('');$('baseline-select').value=baseline.id;
 const suffix=isActual?'for selected dates':'per year';
 $('metrics').innerHTML=`<div class="metric"><p>Baseline</p><strong>${money(baseline.original.total)}</strong><span>${esc(tariffLabel(baseline))}, ${suffix} at current timing</span></div><div class="metric"><p>Lowest modelled cost</p><strong>${money(best.active.total)}</strong><span>${esc(tariffLabel(best))}</span></div><div class="metric saving"><p>Potential saving</p><strong>${money(Math.max(0,best.saving))}</strong><span>${isActual&&stats.missing?'Incomplete data: treat with caution':suffix+' under this scenario'}</span></div>`;
 $('quick-estimate').hidden=isActual||!state.shift;
 if(!isActual&&state.shift){const evNow=baseline.original.evCost,evNew=best.active.evCost;const evSaving=evNow-evNew,otherChange=evSaving-best.saving;
  $('quick-estimate').innerHTML=`<strong>What drives this estimate</strong><p>Home charging: ${money(evNow)} → ${money(evNew)} per year on ${esc(tariffLabel(best))}. The rest of the home and standing charges cost ${money(Math.abs(otherChange))} ${otherChange>=0?'more':'less'} than ${esc(tariffLabel(baseline))}.</p><p class="small">Assumes ${(state.config.homeNightShare*100).toFixed(0)}% of non-EV use falls between 23:00–06:00. Adjust this below or alongside to see the effect.</p>`;
 }
 // evRated: car kWh priced at the selected tariff's own EV rate, averaged per clock slot like home and car use.
 let home,ev,evRated,display,p;if(isActual){display=state.shift&&stats.hasEV?shiftEV(records,selected,config).records:records;const split=ownEV(selected)&&stats.hasEV?evSplit(display,selected):null;
  home=Array(48).fill(0);ev=Array(48).fill(0);evRated=Array(48).fill(0);const counts=Array(48).fill(0);display.forEach((r,n)=>{const i=r.minute/30;home[i]+=r.kwh-(r.ev||0);ev[i]+=r.ev||0;if(split)evRated[i]+=split[n];counts[i]++;});
  [home,ev,evRated]=[home,ev,evRated].map(a=>a.map((v,i)=>v/(counts[i]||1)));}
 else{p=simulate(config,selected,state.shift);home=p.profile.map((v,i)=>v-p.evProfile[i]);ev=p.evProfile;evRated=ownEV(selected)?p.evRatedProfile:Array(48).fill(0);}
 hideTip();$('profile-chart').innerHTML=profileSVG(home,ev,evRated,selected);if(document.activeElement===$('profile-chart')&&lastSlot!=null)showSlot(lastSlot);$('chart-title').textContent=isActual?'Average measured day':'Your modelled daily rhythm';
 $('chart-description').textContent=`${tariffLabel(selected)}. ${isActual?'Average of available readings at each clock time.':'An estimated daily pattern, scaled to your annual use.'}`;
 $('ledger-subtitle').textContent=`${isActual?'Costs for selected dates':'Annual costs'} at rates checked ${checkedOn}. Select a row to inspect its rates.`;
 $('tariff-rows').innerHTML=resultRows.filter(t=>t.active).map(t=>`<tr class="${t.id===selected.id?'active-row':''}"><td>${t.custom?`<strong>${esc(t.supplier||t.name)}</strong><small>${t.supplier?esc(t.name)+' ':''}<span class="pill custom-pill">Added by you</span></small>${t.ev&&t.active.evApplied===false?'<small class="ev-not-applied">EV rate not applied: readings have no EV kWh column</small>':''}`:`<strong>${esc(t.supplier)}</strong><small>${esc(t.name)}${state.overrides[t.id]?' · edited':''}</small>`}</td><td>${money(t.original.total)}</td><td>${isActual&&!stats.hasEV?'<span class="muted">EV data needed</span>':money(t.optimised.total)}</td><td class="${t.saving>=0?'saving-cell':'cost-cell'}">${t.isBaseline?'Baseline'+(Math.abs(t.saving)>=.5?` <small>${money(Math.abs(t.saving))} ${t.saving>0?'less':'more'} with this timing</small>`:''):t.saving>=0?money(t.saving)+' less':money(-t.saving)+' more'}</td><td><button data-tariff="${t.id}">Rates</button></td></tr>`).join('');
 document.querySelectorAll('[data-tariff]').forEach(b=>{b.onclick=()=>state.customTariffs.some(t=>t.id===b.dataset.tariff)?openCustomTariff(b.dataset.tariff):openTariff(b.dataset.tariff);b.closest('tr').onclick=e=>{if(e.target.closest('button'))return;state.selected=b.dataset.tariff;persist();render();};});
 const needed=resultRows.filter(t=>!t.active);$('quote-needed').hidden=!needed.length;
 $('quote-cards').innerHTML=needed.map(t=>`<div class="quote-card"><h4>${esc(t.supplier)}<br>${esc(t.name)}</h4><p>${t.night}p ${t.type==='ev-only'?'EV rate':'night rate'}<br>Household quote needed</p><button data-quote="${t.id}">Enter quote</button></div>`).join('');document.querySelectorAll('[data-quote]').forEach(b=>b.onclick=()=>openTariff(b.dataset.quote));
 const breakdown=isActual?costBreakdown(display,selected):simulatedBreakdown(selected,p);renderChartKey(selected,breakdown,isActual,chartModel.showEV);renderBreakdown(selected,breakdown,isActual);
 renderCustomList();renderUsage();renderData();
}
// The one chart key, above the chart: two thin share bars, then one row per rate (cheapest first, in the same order as the bar
// segments) with its price, times and share of your energy and unit cost, then one muted line. The bars are decorative; the rows carry the numbers.
function renderChartKey(t,b,isActual,showEV){const el=$('chart-key');
 const sep='<span class="visually-hidden">, </span>',sw=(cls,style='')=>`<span class="swatch ${cls}"${style?` style="${style}"`:''} aria-hidden="true"></span>`;
 const row=x=>`<li class="key-row${x.ev?' key-ev':''}" data-band="${esc(x.name)}">${x.swatch}<strong class="key-name">${esc(x.name)}</strong>${sep}<span class="key-rate">${x.rate}p/kWh</span>${sep}<span class="key-when">${esc(x.when)}</span>${x.when?sep:''}<span class="key-share">${esc(x.share)}</span></li>`;
 const list=rows=>`<ul class="key-list" aria-label="Rate bands for ${esc(tariffLabel(t))}: price, times and share of your energy and unit cost">${rows.map(row).join('')}</ul>`;
 const fills=neutral=>showEV?`<span class="key-fill">${sw('fill-home'+(neutral?' neutral':''))}Home</span> <span class="key-fill">${sw('fill-car'+(neutral?' neutral':''))}Car charging (hatched)</span> · `:'';
 const show=html=>{el.innerHTML=html;el.hidden=false;};
 if(!t?.active){el.hidden=true;el.innerHTML='';return;}
 if(t.type==='ev-only')return show(list([{name:'Household',rate:t.day,when:'All day',share:'',swatch:sw('fill-home neutral')},{name:'EV charging',ev:true,rate:t.night,when:'Eligible smart charging',share:'',swatch:sw('fill-car neutral')}])
  +`<p class="small key-foot">${fills(true)}The cheaper rate depends on what the energy is used for, so usage is not coloured by band.</p>`);
 const bands=bandView(t);if(!bands){el.hidden=true;el.innerHTML='';return;}
 const e=evView(t),shares=b?bandShares(b):[],byName=new Map(shares.filter(s=>!s.ev).map(s=>[s.name,s])),evShare=shares.find(s=>s.ev);
 const shareText=s=>s?`${s.kwhPct}% of energy · ${s.costPct}% of cost`:'';
 const rows=bands.map((x,i)=>({...x,order:i,when:x.when||(/^all day$/i.test(x.name)?'':'All day'),s:byName.get(x.name),swatch:sw('band',`background:${x.colour}`)}));
 if(e)rows.push({...e,order:rows.length,s:evShare,swatch:sw('band hatched',`background-color:${e.colour}`)});
 for(const x of rows)x.share=x.ev&&b?.evApplied===false?'Not applied: these readings have no separate EV kWh column':shareText(x.s);
 rows.sort((a,c)=>a.rate-c.rate||Number(!!a.ev)-Number(!!c.ev)||a.order-c.order);
 const bar=(label,key)=>`<div class="share-bar"><span class="share-label">${label}</span><span class="share-track">${rows.filter(x=>x.s?.[key]>0).map(x=>`<span class="share-seg${x.ev?' hatched':''}" style="width:${(x.s[key]*100).toFixed(2)}%;background-color:${x.colour}"></span>`).join('')}</span></div>`;
 const spill=e&&b?.evApplied!==false&&(!e.anyTime||e.cap!=null)?` Car charging ${!e.anyTime&&e.cap!=null?'outside the EV times or over the cap':!e.anyTime?'outside the EV times':'over the daily cap'} is charged at the band rate.`:'';
 show((rows.length>1&&b?`<div class="share-bars" aria-hidden="true">${bar('Your energy','kwhShare')}${bar('Your cost','costShare')}</div>`:'')+list(rows)
  +`<p class="small key-foot">${fills(false)}Unit costs only; standing charge excluded · ${isActual?'Measured readings for the selected dates.':'Annual simulation.'}${spill}</p>`);}
// Only the summary text and body change, so the pane keeps its open/closed state across re-renders.
function renderBreakdown(t,b,isActual){
 $('breakdown-pane').hidden=false;$('breakdown-summary').textContent=b?`${tariffLabel(t)} · ${precise(b.total)} ${isActual?'for selected dates':'per year'}`:tariffLabel(t);
 const head=`<p class="small">${isActual?'Measured readings for the selected dates, priced at UK local time.':'Annual simulation. Import half-hourly readings to see each month.'} Select a row in the tariff comparison to inspect it.</p>`;
 if(!b){$('breakdown').innerHTML=head+`<p class="small">${t.type==='ev-only'?'This EV-only discount applies to EV energy, so a band breakdown is not shown.':'Enter the rates for this tariff to see a breakdown.'}</p>`;return;}
 const pct=x=>b.kwh>0?Math.round(x/b.kwh*100)+'%':'—',share=x=>b.total>0?Math.round(x/b.total*100)+'%':'—';
 const notApplied=t.ev&&b.evApplied===false?`<p class="small ev-not-applied">This tariff’s EV charging rate (${t.ev.rate}p/kWh) is not applied. Your readings are whole-house only, so car charging can’t be separated and all use is priced at the household bands. Import readings with an EV kWh column, or use the annual simulation, to apply it.</p>`:'';
 let html=head+notApplied+`<div class="breakdown-split"><div><p>Unit charges</p><strong>${precise(b.energy)}</strong><span>${share(b.energy)} of total · ${number(b.kwh)} kWh</span></div><div><p>Standing charges</p><strong>${precise(b.standing)}</strong><span>${share(b.standing)} of total · ${b.days} days at ${t.standing}p</span></div><div><p>Total</p><strong>${precise(b.total)}</strong><span>${isActual?'for selected dates':'per year'}</span></div></div>`;
 html+=`<div class="table-wrap"><table><caption>Cost by rate band</caption><thead><tr><th scope="col">Band</th><th scope="col">Rate</th><th scope="col">kWh</th><th scope="col">Share of use</th><th scope="col">Cost</th></tr></thead><tbody>${b.bands.map(x=>`<tr><th scope="row">${esc(x.name)}</th><td>${x.rate}p/kWh</td><td>${number(x.kwh)}</td><td>${pct(x.kwh)}</td><td>${precise(x.cost)}</td></tr>`).join('')}</tbody></table></div>`;
 if(b.months)html+=`<div class="table-wrap"><table><caption>Monthly breakdown</caption><thead><tr><th scope="col">Month</th><th scope="col">Days</th><th scope="col">kWh</th>${b.bands.length>1?b.bands.map(x=>`<th scope="col">${esc(x.name)} kWh</th>`).join(''):''}<th scope="col">Unit</th><th scope="col">Standing</th><th scope="col">Total</th></tr></thead><tbody>${b.months.map(m=>`<tr><th scope="row">${m.month}</th><td>${m.days}</td><td>${number(m.kwh)}</td>${b.bands.length>1?m.bands.map(x=>`<td>${number(x.kwh)}</td>`).join(''):''}<td>${precise(m.energy)}</td><td>${precise(m.standing)}</td><td>${precise(m.total)}</td></tr>`).join('')}</tbody></table></div>`;
 $('breakdown').innerHTML=html;
}
function renderCustomList(){const list=state.customTariffs.map(compileTariff);$('add-tariff').disabled=list.length>=MAX_CUSTOM;
 $('custom-tariff-list').innerHTML=list.length?list.map(t=>`<div class="custom-row"><div><strong>${esc(tariffLabel(t))} <span class="pill custom-pill">Added by you</span></strong><small>${t.standing}p/day standing · ${esc(bandText(t))}</small></div><div class="button-row"><button type="button" data-edit-custom="${t.id}" aria-label="Edit ${esc(tariffLabel(t))}">Edit</button><button type="button" class="subtle danger" data-delete-custom="${t.id}" aria-label="Delete ${esc(tariffLabel(t))}">Delete</button></div></div>`).join(''):'<p class="small">No tariffs added yet. Add one by name with its standing charge and rate bands, such as peak, off-peak and super off-peak.</p>';
 document.querySelectorAll('[data-edit-custom]').forEach(b=>b.onclick=()=>openCustomTariff(b.dataset.editCustom));
 document.querySelectorAll('[data-delete-custom]').forEach(b=>b.onclick=()=>deleteCustom(b.dataset.deleteCustom));}
function renderUsage(){
 const bills=state.bills||[];if(bills.length>=2){const [a,b]=[bills[0],bills.at(-1)],increase=(b.kwh/a.kwh-1)*100,usageEffect=(b.kwh-a.kwh)*a.unitExVat*(1+a.vat/100)/100;
 $('bill-insights').innerHTML=`<div class="bill-grid"><section class="panel"><h2>Higher use is driving the bill</h2><p>Usage changed by ${increase.toFixed(1)}% from ${a.month} to ${b.month}. The electricity charge rose from ${precise(a.electricity)} to ${precise(b.electricity)}.</p><div class="bill-bar"><span>${a.month}</span><i style="width:${a.kwh/b.kwh*50}%"></i><strong>${number(a.kwh)} kWh</strong></div><div class="bill-bar current"><span>${b.month}</span><i style="width:50%"></i><strong>${number(b.kwh)} kWh</strong></div><p>About <strong>${precise(usageEffect)}</strong> of the increase comes from using more electricity, valued at the old unit rate. Price and standing-charge changes explain the rest.</p></section><section class="panel"><h2>Payments and actual charges</h2><p class="big-note">${precise(b.total)}</p><p>Latest imported energy charge: electricity ${precise(b.electricity)}, gas ${precise(b.gas)}.</p>${state.account?`<p>EDF currently shows a <strong>${precise(state.account.monthlyDirectDebit)} monthly Direct Debit</strong> and ${precise(state.account.credit)} credit, checked ${esc(state.account.observedOn)}.</p>`:''}<p>A Direct Debit is a payment towards the account, not the cost of that month’s consumption.</p></section></div>`;
 }else $('bill-insights').innerHTML='<section class="empty"><h3>Your bills, explained here</h3><p>Import a saved household file to see verified bill totals. Half-hourly CSV files populate the consumption analysis below.</p></section>';
 const t=state.tesla;const chargingTotal=t?Number(t.homeKwh)+Number(t.superchargerKwh)+Number(t.otherKwh):0;const chargingShare=k=>chargingTotal>0?Math.max(0,Number(k)/chargingTotal*100):0;$('tesla-insights').innerHTML=t?`<section class="panel"><div class="section-head"><div><h2>Your Tesla’s share</h2><p>${esc(t.period)}</p></div><span class="badge">Measured charging totals</span></div><div class="split-bar"><span style="width:${chargingShare(t.homeKwh)}%;background:#2860cc"></span><span style="width:${chargingShare(t.superchargerKwh)}%;background:#c44d65"></span><span style="width:${chargingShare(t.otherKwh)}%;background:#91a1b5"></span></div><div class="tesla-legend"><div><strong>${number(t.homeKwh)} kWh</strong>Home</div><div><strong>${number(t.superchargerKwh)} kWh</strong>Superchargers</div><div><strong>${number(t.otherKwh)} kWh</strong>Other locations</div></div><p class="charge-total">The home figure is about ${(t.homeKwh/state.config.annualKwh*100).toFixed(0)}% of your annual household electricity. Only home charging is included in the tariff model.</p><p>${esc(t.note)}</p><p class="small">Source: ${esc(t.source)}. The screenshot contains totals, not session times. Charger power, plug-in hours, and any allowance for losses remain assumptions.</p></section>`:'';
 const s=dataStats(state.records);if(s){const months={};state.records.forEach(r=>months[r.date.slice(0,7)]=(months[r.date.slice(0,7)]||0)+r.kwh);const max=Math.max(...Object.values(months));
 $('meter-insights').innerHTML=`<section class="panel"><h2>Measured electricity</h2><p>${number(s.kwh)} kWh across ${s.days} calendar days. ${s.missing?`${s.missing} missing intervals; incomplete periods are not extrapolated.`:'No missing intervals across the covered dates.'}</p><div class="monthly-bars">${Object.entries(months).map(([m,k])=>`<div style="height:${k/max*180}px" tabindex="0" aria-label="${m}: ${number(k)} kilowatt hours"><strong>${number(k)} kWh</strong><span>${m}</span></div>`).join('')}</div>${reconciliation()}</section>`;
 }else $('meter-insights').innerHTML=`<section class="panel"><h2>Half-hourly history is the missing piece</h2><p>${esc(state.meterStatus||'No half-hourly consumption has been imported.')}</p><p>Without it, the dashboard can estimate tariff costs from annual totals but cannot establish your actual overnight share, identify appliance loads, or prove when the car charged.</p>${state.registerReadings?.length?`<h3>Available meter-register readings</h3><table><thead><tr><th>Date</th><th>Cumulative kWh</th></tr></thead><tbody>${state.registerReadings.map(r=>`<tr><td>${esc(r.date)}</td><td>${number(r.reading)}</td></tr>`).join('')}</tbody></table><p class="small">Register readings are cumulative totals. July and August values were displayed rounded to whole kWh by EDF.</p>`:''}</section>`;
}
function reconciliation(){return (state.bills||[]).map(b=>{const r=state.records.filter(r=>r.date.startsWith(b.month));if(!r.length)return '';const s=dataStats(r),kwh=s.kwh;const full=s.days===b.days&&s.missing===0;return `<p><strong>${b.month} bill check:</strong> ${number(kwh)} kWh imported vs ${number(b.kwh)} kWh billed. ${full?`Reconstructed charge ${precise(billCost(kwh,b.days,b.unitExVat,b.standingExVat,b.vat))}, bill ${precise(b.electricity)}.`:'The imported month is incomplete; a full reconciliation is not possible yet.'}</p>`;}).join('');}
function renderData(){const s=dataStats(state.records);$('data-summary').textContent=s?`${state.records.length.toLocaleString()} intervals, ${s.start} to ${s.end}. ${state.filename?'Imported from '+state.filename+'.':''}`:'No half-hourly readings loaded. Annual bill and Tesla totals can still power a labelled simulation.';
 $('connection-status').textContent=[state.meterStatus,state.loop?`Loop: ${state.loop.daysAvailable} days listed, last updated ${state.loop.lastUpdated.slice(0,10)}. Address consent was reconfirmed on ${state.loop.consentReconfirmed}; new readings have not yet been verified. Loop currently provides no data download or API.`:''].filter(Boolean).join(' ');
 $('data-quality').innerHTML=s?`<div class="quality"><div><strong>${(s.coverage*100).toFixed(1)}%</strong><span>Interval coverage</span></div><div><strong>${s.missing}</strong><span>Missing half-hours</span></div><div><strong>${number(s.kwh)}</strong><span>Measured kWh</span></div></div>${reconciliation()}`:'';
 $('export-readings').disabled=!state.records.length;$('source-list').innerHTML=tariffs().map(t=>`<div class="source-row"><a href="${esc(t.source)}" target="_blank" rel="noreferrer">${esc(t.supplier)}: ${esc(t.name)}</a><small>${t.day??'Quote'}p day · ${t.night??'—'}p cheap · ${t.standing??'Quote'}p/day standing${state.overrides[t.id]?' · edited locally':''}</small></div>`).join('');}
function openTariff(id){editingId=id;state.selected=id;persist();render();const t=tariffs().find(t=>t.id===id);$('tariff-title').textContent=t.name;$('tariff-note').textContent=t.note;$('tariff-day').value=t.day??'';$('tariff-night').value=t.night??'';$('tariff-night').disabled=t.type==='flat';$('tariff-standing').value=t.standing??'';$('tariff-start').value=clock(t.start??0);$('tariff-end').value=clock(t.end??360);$('tariff-window').hidden=t.type!=='tou';$('tariff-terms').textContent=`${t.term}. Exit fee: ${t.exit===null?'confirm in quote':precise(t.exit)}. ${t.type==='ev-only'?'EV-only discount; household consumption stays on the entered day rate.':''}`;$('tariff-source').href=t.source;$('tariff-dialog').showModal();}
function download(name,content,type='text/plain'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);}
function configureDates(){const s=dataStats(state.records);if(!s)return;for(const id of ['from-date','to-date']){$(id).min=s.start;$(id).max=s.end;}state.from=state.from||s.start;state.to=state.to||s.end;$('from-date').value=state.from;$('to-date').value=state.to;}
async function importFile(file){if(!file)return;if(file.size>15*1024*1024)throw Error('Choose a file smaller than 15 MB.');const text=await file.text();if(file.name.toLowerCase().endsWith('.json')){state=readBackup(JSON.parse(text));state.filename=file.name;importedDefaults=validConfig(state.importedDefaults||state.config);state.importedDefaults=importedDefaults;persist();controls();configureDates();render();toast('Household data loaded. It stays in this browser.');return;}
 pendingCSV=parseCSV(text);pendingCSV.filename=file.name;$('import-file-name').textContent=`${file.name}: ${pendingCSV.rows.length.toLocaleString()} rows`;
 for(const key of ['start','time','kwh','ev','end']){const sel=$('map-'+key);sel.innerHTML=(['start','kwh'].includes(key)?'':'<option value="">Not provided</option>')+pendingCSV.headers.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('');const match=pendingCSV.headers.find(h=>({start:/^(interval_start|start|timestamp|date.*time|date|start.*time)$/i,time:/^time$/i,kwh:/^(consumption(_kwh)?|consumption \(kwh\)|electricity.*kwh.*|energy.*kwh.*|kwh)$/i,ev:/^(ev_kwh|ev.*kwh.*)$/i,end:/^(interval_end|end|end.*time)$/i}[key]).test(h));if(match&&(key!=='ev'||pendingCSV.rows.some(row=>String(row[pendingCSV.headers.indexOf(match)]??'').trim())))sel.value=match;}
 $('import-error').textContent='';$('import-dialog').showModal();}
$('paste-data').onclick=()=>{$('paste-error').textContent='';$('paste-dialog').showModal();};
$('paste-form').onsubmit=async e=>{e.preventDefault();try{const text=$('paste-content').value;const name=text.trim().startsWith('{')?'pasted-household.json':'pasted-readings.csv';await importFile(new File([text],name));$('paste-content').value='';$('paste-dialog').close();}catch(err){$('paste-error').textContent=err.message;}};
$('file-input').onchange=async e=>{try{await importFile(e.target.files[0]);}catch(err){toast(err.message);}e.target.value='';};
for(const id of ['import-top','import-data'])$(id).onclick=()=>$('file-input').click();
$('mapping-form').onsubmit=e=>{e.preventDefault();try{const mapping=Object.fromEntries(['start','time','kwh','ev','end','zone'].map(k=>[k,$('map-'+k).value]));const r=recordsFromCSV(pendingCSV,mapping);state.records=r.records;state.filename=pendingCSV.filename;state.basis='actual';state.from=null;state.to=null;state.shift=false;persist();controls();configureDates();$('import-dialog').close();showView('compare');render();toast(`${r.records.length.toLocaleString()} readings imported${r.duplicates?`; ${r.duplicates} identical duplicates removed`:''}${r.skippedMissing?`; ${r.skippedMissing} missing rows skipped`:''}.`);}catch(err){$('import-error').textContent=err.message;}};
$('tariff-form').onsubmit=e=>{e.preventDefault();const t=tariffs().find(t=>t.id===editingId);const o={day:Number($('tariff-day').value),standing:Number($('tariff-standing').value)};if(t.type!=='flat')o.night=Number($('tariff-night').value);if(t.type==='tou'){o.start=minute($('tariff-start').value);o.end=minute($('tariff-end').value);if(o.start===o.end){toast('Choose different cheap-window start and end times.');return;}}state.overrides[editingId]=o;persist();$('tariff-dialog').close();render();toast('Comparison updated with your rates.');};
$('tariff-reset').onclick=()=>{delete state.overrides[editingId];persist();$('tariff-dialog').close();render();};
// Custom tariff editor. The draft keeps form values as strings until they are read back into a tariff model.
const templates={flat:()=>[{name:'All day',rate:'',fallback:true,windows:[]}],
 three:()=>[{name:'Peak',rate:'',fallback:false,windows:[{start:'16:00',end:'19:00'}]},{name:'Super off-peak',rate:'',fallback:false,windows:[{start:'02:00',end:'05:00'}]},{name:'Off-peak',rate:'',fallback:true,windows:[]}]};
function renderBands(bands){
 $('band-list').innerHTML=bands.map((b,i)=>`<fieldset class="band-row" data-band="${i}"><legend>Band ${i+1}</legend><div class="two-cols"><label>Band name<input class="band-name" maxlength="40" required value="${esc(b.name)}"></label><label>Unit rate (p/kWh)<input class="band-rate" type="number" min="0" max="200" step="0.0001" required value="${esc(b.rate)}"></label></div>
 <label class="check"><input class="band-fallback" type="checkbox"${b.fallback?' checked':''}> All other times</label>
 <div class="band-windows"${b.fallback?' hidden':''}>${b.windows.map((w,j)=>`<div class="window-row"><label>From<input class="win-start" type="time" step="1800" value="${esc(w.start)}"></label><label>Until<input class="win-end" type="time" step="1800" value="${esc(w.end)}"></label><button type="button" class="subtle" data-remove-window="${i}:${j}" aria-label="Remove window ${j+1} from band ${i+1}">×</button></div>`).join('')}<button type="button" class="subtle" data-add-window="${i}"${b.windows.length>=8?' disabled':''}>Add time window</button></div>
 <button type="button" class="subtle danger" data-remove-band="${i}"${bands.length<2?' disabled':''} aria-label="Remove band ${i+1}">Remove band</button></fieldset>`).join('');
 $('add-band').disabled=bands.length>=6;
 for(const b of document.querySelectorAll('[data-add-window]'))b.onclick=()=>{const d=readDraft();d[b.dataset.addWindow].windows.push({start:'',end:''});renderBands(d);validateCustom();};
 for(const b of document.querySelectorAll('[data-remove-window]'))b.onclick=()=>{const [i,j]=b.dataset.removeWindow.split(':').map(Number);const d=readDraft();d[i].windows.splice(j,1);renderBands(d);validateCustom();};
 for(const b of document.querySelectorAll('[data-remove-band]'))b.onclick=()=>{const d=readDraft();d.splice(Number(b.dataset.removeBand),1);renderBands(d);validateCustom();};
 for(const c of document.querySelectorAll('.band-fallback'))c.onchange=()=>{c.closest('.band-row').querySelector('.band-windows').hidden=c.checked;validateCustom();};
}
// Optional EV charging rate: its windows are kept apart from the bands and read only while the checkbox is ticked.
function renderEvWindows(list){
 $('ev-windows').innerHTML=list.map((w,j)=>`<div class="window-row"><label>From<input class="ev-win-start" type="time" step="1800" value="${esc(w.start)}"></label><label>Until<input class="ev-win-end" type="time" step="1800" value="${esc(w.end)}"></label><button type="button" class="subtle" data-remove-ev-window="${j}" aria-label="Remove EV window ${j+1}">×</button></div>`).join('');
 $('ev-any').hidden=list.length>0;$('ev-add-window').disabled=list.length>=8;
 for(const b of document.querySelectorAll('[data-remove-ev-window]'))b.onclick=()=>{const d=readEvWindows();d.splice(Number(b.dataset.removeEvWindow),1);renderEvWindows(d);validateCustom();};}
const readEvWindows=()=>[...document.querySelectorAll('#ev-windows .window-row')].map(w=>({start:w.querySelector('.ev-win-start').value,end:w.querySelector('.ev-win-end').value}));
function readDraft(){return [...document.querySelectorAll('#band-list .band-row')].map(row=>({name:row.querySelector('.band-name').value,rate:row.querySelector('.band-rate').value,fallback:row.querySelector('.band-fallback').checked,windows:[...row.querySelectorAll('.window-row')].map(w=>({start:w.querySelector('.win-start').value,end:w.querySelector('.win-end').value}))}));}
function readCustomForm(){const num=v=>String(v).trim()===''?null:Number(v);
 return {id:editingCustom||'custom-'+Date.now().toString(36),supplier:$('custom-supplier').value.trim(),name:$('custom-name').value.trim(),standingChargePencePerDay:num($('custom-standing').value),
  bands:readDraft().map(b=>({name:b.name.trim(),ratePencePerKWh:num(b.rate),windows:b.fallback?[]:b.windows})),
  ...($('ev-enabled').checked?{ev:{ratePencePerKWh:num($('ev-rate-input').value),windows:readEvWindows(),...(String($('ev-cap').value).trim()===''?{}:{dailyCapKWh:num($('ev-cap').value)})}}:{})};}
function validateCustom(){try{const def=readCustomForm();if(!def.supplier)throw Error('Give the supplier a name of up to 80 characters.');compileTariff(def);$('custom-tariff-error').textContent='';return true;}catch(e){$('custom-tariff-error').textContent=e.message;return false;}}
function openCustomTariff(id){const def=state.customTariffs.find(t=>t.id===id);editingCustom=def?.id;
 $('custom-tariff-title').textContent=def?'Edit your tariff':'Add your tariff';$('custom-supplier').value=def?.supplier??'';$('custom-name').value=def?.name??'';$('custom-standing').value=def?.standingChargePencePerDay??'';
 renderBands(def?def.bands.map(b=>({name:b.name,rate:b.ratePencePerKWh,fallback:!b.windows.length,windows:b.windows.map(w=>({...w}))})):templates.flat());
 $('ev-enabled').checked=!!def?.ev;$('ev-fields').hidden=!def?.ev;$('ev-rate-input').value=def?.ev?.ratePencePerKWh??'';$('ev-cap').value=def?.ev?.dailyCapKWh??'';renderEvWindows((def?.ev?.windows||[]).map(w=>({...w})));
 $('custom-delete').hidden=!def;$('custom-tariff-error').textContent='';$('custom-tariff-dialog').showModal();}
function deleteCustom(id){const def=state.customTariffs.find(t=>t.id===id);if(!def||!confirm(`Delete “${tariffLabel({supplier:def.supplier?.trim(),name:def.name})}” from this browser?`))return false;
 state.customTariffs=state.customTariffs.filter(t=>t.id!==id);if(state.selected===id)state.selected='edf-18';if(state.baseline===id)state.baseline='edf-standard';persist();render();toast('Tariff deleted.');return true;}
$('add-tariff').onclick=()=>openCustomTariff(null);
$('add-band').onclick=()=>{const d=readDraft();d.push({name:'',rate:'',fallback:false,windows:[{start:'',end:''}]});renderBands(d);validateCustom();};
for(const b of document.querySelectorAll('[data-template]'))b.onclick=()=>{renderBands(templates[b.dataset.template]());validateCustom();};
$('custom-tariff-form').oninput=validateCustom;
$('ev-enabled').onchange=()=>{$('ev-fields').hidden=!$('ev-enabled').checked;validateCustom();};
$('ev-add-window').onclick=()=>{const d=readEvWindows();d.push({start:'',end:''});renderEvWindows(d);validateCustom();};
$('custom-tariff-form').onsubmit=e=>{e.preventDefault();if(!validateCustom())return;const def=readCustomForm(),i=state.customTariffs.findIndex(t=>t.id===def.id);
 if(i>=0)state.customTariffs[i]=def;else{if(state.customTariffs.length>=MAX_CUSTOM){$('custom-tariff-error').textContent=`You can add up to ${MAX_CUSTOM} tariffs.`;return;}state.customTariffs.push(def);}
 state.selected=def.id;persist();$('custom-tariff-dialog').close();render();toast('Comparison updated with your tariff.');};
$('custom-delete').onclick=()=>{if(deleteCustom(editingCustom))$('custom-tariff-dialog').close();};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>showView(b.dataset.view);
for(const id of ['annual-kwh','ev-kwh','night-share','power','arrival','departure','overhead'])$(id).addEventListener('input',readControls);
$('current-mode').onclick=()=>{state.shift=false;persist();render();};$('shifted-mode').onclick=()=>{state.shift=true;persist();render();};$('basis').onchange=e=>{state.basis=e.target.value;persist();render();};
$('baseline-select').onchange=e=>{state.baseline=e.target.value;persist();render();};
for(const k of ['from','to'])$(k+'-date').onchange=e=>{state[k]=e.target.value;persist();render();};$('all-dates').onclick=()=>{state.from=null;state.to=null;configureDates();persist();render();};
$('reset-inputs').onclick=()=>{state.config={...importedDefaults};controls();persist();render();};
$('save-backup').onclick=()=>download('energy-lens-private-backup.json',JSON.stringify({...state,importedDefaults},null,2),'application/json');
$('export-readings').onclick=()=>download('half-hourly-electricity.csv',recordsToCSV(state.records),'text/csv');
$('export-comparison').onclick=()=>{const baselineRow=resultRows.find(t=>t.isBaseline),cell=x=>'"'+String(x??'').replace(/"/g,'""')+'"';download('tariff-comparison.csv',[['Supplier','Tariff','Basis','Scenario','Current timing GBP','Overnight EV GBP','Saving vs baseline GBP','Day p/kWh','Cheap p/kWh','Standing p/day','Rates checked','Bands','Baseline tariff'],...resultRows.map(t=>[t.supplier,t.name,state.basis,state.shift?'Overnight EV':'Current timing',t.original?.total.toFixed(2),state.basis==='actual'&&!dataStats(filtered())?.hasEV?'':t.optimised?.total.toFixed(2),t.saving?.toFixed(2),t.day,t.night,t.standing,t.custom?'':checkedOn,t.type==='bands'?bandText(t):'',baselineRow?tariffLabel(baselineRow):''])].map(r=>r.map(cell).join(',')).join('\n'),'text/csv');};
$('template').onclick=()=>download('half-hourly-template.csv','interval_start,consumption_kwh,ev_kwh\n2026-09-01T00:00:00+01:00,0.40,0.20\n2026-09-01T00:30:00+01:00,0.35,0.15\n','text/csv');
$('clear-data').onclick=()=>{if(!confirm('Remove readings and household details from this browser? Download a private backup first if you want to keep them.'))return;localStorage.removeItem('energy-lens-v1');location.reload();};
controls();configureDates();render();
