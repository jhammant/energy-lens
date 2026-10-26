import {simulate, sum, rateAt} from '../engine.mjs';

// A fixed fictional scenario. This page never reads or writes browser storage.
const config = {annualKwh:8000, evKwh:2400, homeNightShare:.25, power:7, arrival:1080, departure:420};
const tariff = {type:'tou', day:30, night:10, standing:50, start:0, end:360};
const money = new Intl.NumberFormat('en-GB', {style:'currency', currency:'GBP'});
const chart = document.getElementById('demo-chart');
const arrival = document.getElementById('demo-arrival');
const overnight = document.getElementById('demo-overnight');

function render(shift) {
  const model = simulate(config, tariff, shift);
  const home = model.profile.map((kwh, i) => kwh - model.evProfile[i]);
  const width = 620, pad = 22, baseline = 202, height = 164;
  const slot = (width - pad * 2) / 48, scale = height / 4;
  let svg = '<title id="chart-title">Illustrative electricity use across a day</title>';
  svg += `<desc id="chart-desc">Synthetic example. Car charging ${shift?'after midnight':'on arrival at 18:00'}, with the household profile unchanged. Blue is home and teal is car.</desc>`;
  svg += `<rect x="${pad}" y="22" width="${slot*12}" height="${baseline-22}" rx="4" fill="#eaf1fe"/>`;
  for (const value of [1,2,3]) {
    const y = baseline - value * scale;
    svg += `<line x1="${pad}" x2="${width-pad}" y1="${y}" y2="${y}" stroke="#dce5ef" stroke-dasharray="3 4"/>`;
  }
  for (let i=0; i<48; i++) {
    const x = pad + i*slot + 2, h = home[i]*scale, ev = model.evProfile[i]*scale;
    svg += `<rect x="${x}" y="${baseline-h}" width="${slot-4}" height="${h}" rx="2" fill="#2860cc"/>`;
    if (ev>0) svg += `<rect x="${x}" y="${baseline-h-ev}" width="${slot-4}" height="${ev}" rx="2" fill="#167c80"/>`;
  }
  for (const hour of [0,6,12,18,24]) {
    const anchor = hour===0?'start':hour===24?'end':'middle';
    svg += `<text x="${pad+hour/24*(width-2*pad)}" y="230" text-anchor="${anchor}">${String(hour).padStart(2,'0')}:00</text>`;
  }
  chart.innerHTML = svg;
  arrival.setAttribute('aria-pressed', String(!shift));
  overnight.setAttribute('aria-pressed', String(shift));
  document.getElementById('demo-timing').textContent = shift?'Charging overnight':'Charging on arrival';
  document.getElementById('demo-cost').textContent = money.format(sum(model.evProfile.map((kwh,i)=>kwh*rateAt(tariff,i*30)/100)));
  document.getElementById('demo-explanation').textContent = `The same ${(config.evKwh/365).toFixed(1)} kWh of car charging, now at ${shift?'10p':'30p'}/kWh. Household use stays unchanged.`;
}

arrival.addEventListener('click', ()=>render(false));
overnight.addEventListener('click', ()=>render(true));
render(false);
