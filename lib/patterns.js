// Unnamed repeating power steps and what they might be.
// Pure functions: everything comes in as arguments. Suggestions are never applied automatically.
import { tolFor } from './engine-util.js';

// Broad household rules of thumb, not a model of any particular appliance. w: watts, on/off: typical minutes.
const FINGERPRINTS = [
  { name: 'Fridge or freezer', icon: 'kitchen', w: [70, 260], on: [8, 50], off: [10, 70], why: 'A steady low wattage that cycles on and off every 10-50 minutes is the classic sign of a compressor.' },
  { name: 'Kettle', icon: 'kettle', w: [1700, 3200], on: [0.5, 6], why: 'Very high wattage for just a minute or two at a time.' },
  { name: 'Toaster', icon: 'countertops', w: [700, 1500], on: [0.5, 5], why: 'A short, sharp burst in the small-kitchen-appliance range.' },
  { name: 'Microwave', icon: 'microwave', w: [900, 1800], on: [0.5, 12], why: 'High wattage for a few minutes at a time.' },
  { name: 'Oven', icon: 'oven_gen', w: [1800, 3200], on: [3, 90], off: [3, 40], why: 'High wattage that cycles on and off while holding temperature.' },
  { name: 'Hot water cylinder', icon: 'shower', w: [1800, 3200], on: [20, 240], off: [60, 600], why: 'High wattage on for a long stretch, then off for hours: typical of a hot water element.' },
  { name: 'Clothes dryer', icon: 'dry_cleaning', w: [1800, 3200], on: [25, 100], why: 'High wattage sustained for most of an hour or more.' },
  { name: 'Washing machine', icon: 'local_laundry_service', w: [1700, 2600], on: [10, 50], why: 'A high-wattage stretch of ten to fifty minutes, likely the heating element of a wash.' },
  { name: 'Dishwasher', icon: 'dishwasher_gen', w: [900, 2200], on: [8, 50], why: 'A heating-element burst during part of a wash cycle.' },
  { name: 'Space heater', icon: 'heat', w: [900, 2400], on: [5, 120], off: [5, 60], why: 'A heater-range wattage cycling on and off on a thermostat.' },
  { name: 'Heat pump or air conditioner', icon: 'heat_pump', w: [300, 3000], on: [30, 600], why: 'Runs for a long stretch at a wattage that can vary a lot with an inverter unit.' },
  { name: 'Pool or spa pump', icon: 'pool', w: [350, 1600], on: [60, 600], off: [60, 1400], why: 'Runs for hours at a time, often on a daily schedule.' },
  { name: 'EV charger', icon: 'electric_car', w: [1400, 7600], on: [60, 600], why: 'A big, steady load for hours at a time, likely overnight charging.' },
];

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function cycleStats(evs) {
  const sorted = [...evs].sort((a, b) => a.t - b.t), onDurs = [], offDurs = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (sorted[i].t - sorted[i - 1].t) / 60000; if (gapMin >= 1440) continue;
    if (sorted[i - 1].dir === 'on' && sorted[i].dir === 'off') onDurs.push(gapMin);
    else if (sorted[i - 1].dir === 'off' && sorted[i].dir === 'on') offDurs.push(gapMin);
  }
  return { on: median(onDurs), off: median(offDurs) };
}

export function guessAppliance(mean, evs) {
  const { on, off } = cycleStats(evs);
  let best = null, bestScore = 0, second = 0;
  for (const p of FINGERPRINTS) {
    if (mean < p.w[0] || mean > p.w[1]) continue;
    let score = 2;
    if (on != null && p.on) score += on >= p.on[0] && on <= p.on[1] ? 2 : -3;
    if (off != null && p.off) score += off >= p.off[0] && off <= p.off[1] ? 1 : -2;
    if (score > bestScore) { second = bestScore; best = p; bestScore = score; } else if (score > second) second = score;
  }
  if (!best || bestScore < 2 || bestScore - second < 1) return null; // nothing fits, or too close to call
  return { name: best.name, icon: best.icon, why: best.why };
}

/** Unnamed steps grouped by size: [{ key, mean, evs, n, on, off, last }], at least 2 steps each, most frequent first. */
export function clusters(events) {
  const un = events.filter(e => !e.sig).sort((a, b) => Math.abs(a.d) - Math.abs(b.d)), out = [];
  for (const e of un) {
    const w = Math.abs(e.d), c = out[out.length - 1];
    if (c && Math.abs(w - c.mean) < tolFor(c.mean)) { c.evs.push(e); c.mean = c.evs.reduce((s, x) => s + Math.abs(x.d), 0) / c.evs.length; }
    else out.push({ mean: w, evs: [e] });
  }
  return out.filter(c => c.evs.length >= 2).sort((a, b) => b.evs.length - a.evs.length)
    .map(c => ({ key: `w${Math.round(c.mean)}`, mean: Math.round(c.mean), evs: c.evs, n: c.evs.length,
      on: c.evs.filter(e => e.dir === 'on').length, off: c.evs.filter(e => e.dir === 'off').length, last: Math.max(...c.evs.map(e => e.t)) }));
}

// a device that switched the same way within 20 s of these steps, at least twice and for at least half of them
function deviceHint(c, devEvents) {
  if (!devEvents?.length) return null;
  const counts = new Map();
  for (const e of c.evs) {
    const on = e.dir === 'on', seen = new Set();
    for (const h of devEvents) { // newest first
      if (h.t < e.t - 20e3) break;
      if (h.on !== on || seen.has(h.id)) continue;
      if (e.t >= (h.after ?? h.t) - 20e3 && e.t <= h.t + 20e3) { seen.add(h.id); const x = counts.get(h.id) || { n: 0, name: h.name }; x.n++; counts.set(h.id, x); }
    }
  }
  let best = null; for (const [id, x] of counts) if (!best || x.n > best.n) best = { id, ...x };
  if (!best || best.n < 2 || best.n < c.evs.length * 0.5) return null;
  return { name: best.name, icon: 'power', device: best.id, why: `"${best.name}" switched at the same moment as this step ${best.n} of ${c.evs.length} times.` };
}

/** The best single suggestion for a cluster, or null. dismissed: [{ name, w }] hidden with ✕ on the settings page. */
export function suggestFor(c, { sigs = [], devEvents = [], dismissed = [] } = {}) {
  const off = name => dismissed.some(d => d.name === name && Math.abs(d.w - c.mean) < tolFor(d.w));
  const h = deviceHint(c, devEvents);
  if (h && !off(h.name)) {
    // a device already tracked as an appliance: these steps are that appliance's, from before it was tracked
    const t = sigs.find(s => s.devId && s.devId === h.device);
    return t ? { ...h, name: t.name, icon: t.icon || h.icon, sig: t.id, why: `${h.why} It's tracked as "${t.name}" already.` } : h;
  }
  const known = [];
  for (const s of sigs) {
    if (s.metered) continue; // measured exactly: its steps never need naming
    if (s.count && Math.abs(s.watts - c.mean) < tolFor(s.watts)) known.push({ diff: Math.abs(s.watts - c.mean), sig: s, why: `Same size of step as "${s.name}" (about ${Math.round(s.watts)} W), which you've already named.` });
    for (const st of s.stages || []) if (Math.abs(st.watts - c.mean) < tolFor(st.watts)) known.push({ diff: Math.abs(st.watts - c.mean), sig: s, stage: true, why: `Matches a learned extra stage of "${s.name}" (about ${Math.round(st.watts)} W), like a heating element switching on partway through a run.` });
  }
  const k = known.filter(x => !off(x.sig.name)).sort((a, b) => a.diff - b.diff)[0];
  if (k) return { name: k.sig.name, icon: k.sig.icon || null, sig: k.sig.id, stage: !!k.stage, why: k.why };
  const g = guessAppliance(c.mean, c.evs);
  return g && !off(g.name) ? g : null;
}
