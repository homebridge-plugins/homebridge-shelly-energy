// Ways to save: tips worked out from this home's own readings, each with a figure. Pure: everything comes from the engine
// passed in, nothing is fetched. A tip is shown only when the data behind it is good enough; there are no generic tips.
// Savings are worked out per year and shown per week, month and year.
import { priceAt, hasPlan } from './tariff.js';
import { dayKey, median } from './engine-util.js';

const WINDOW = 30;                    // days looked at
const MIN_DAYS = 3;                   // fewer days of readings than this: no tips yet
const MIN_SAVING_YEAR = 5;            // in money (or kWh when there's no plan): smaller savings aren't worth a tip
// appliances people start themselves, whose runs can be moved to cheaper hours
const SHIFTABLE = /wash|laundry|dryer|dry_cleaning|dish|spa|hot ?tub|pool|cylinder|hot water|shower|\bev\b|electric_car|ev_station|car charg|charger|iron|kiln/i;
const NOT_SHIFTABLE = /fridge|freezer|kitchen|router|server|aquarium|alarm|camera|heat ?pump|heat_pump|light/i;
// a likely cause when an appliance's runs get longer, by what it is
const LONGER = [
  [/fridge|freezer|kitchen|chiller/i, 'often a door seal that no longer closes tightly, dusty coils at the back, or the door left ajar'],
  [/dryer|dry_cleaning/i, 'often a full lint filter or a blocked vent'],
  [/dish/i, 'often a blocked filter or spray arm'],
  [/wash|laundry/i, 'often a blocked filter, or heavier loads than usual'],
  [/spa|hot ?tub|pool/i, 'often a dirty filter, or the cover left off'],
  [/heat ?pump|heat_pump|air ?con|ac_unit/i, 'often dirty filters, or a colder spell'],
  [/cylinder|hot water|shower/i, 'often more hot water used, or a thermostat set higher'],
];

const what = s => `${s.name} ${s.icon || ''}`;
const sum = a => a.reduce((x, y) => x + y, 0);

export function insights(engine, now = Date.now()) {
  const E = engine, T = E.settings.tariff, plan = hasPlan(T);
  const keys = []; for (let i = 1; i <= WINDOW; i++) keys.push(dayKey(now - i * 86400e3)); // whole days only (not today)
  const days = keys.filter(k => E.energy[k]);
  if (days.length < MIN_DAYS) return { tips: [], days: days.length, needDays: MIN_DAYS, plan };
  const perYear = 365 / days.length;
  const at = (k, h) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, h, 30); };
  // the average price actually paid per kWh over the window (for tips that don't depend on the hour)
  let kwhAll = 0, costAll = 0;
  for (const k of days) { const d = E.energy[k]; for (let h = 0; h < 24; h++) { const v = d.h?.[h] ?? (d.total || 0) / 24; kwhAll += v; costAll += v * priceAt(T, at(k, h)); } }
  const avgPrice = plan ? (kwhAll > 0 ? costAll / kwhAll : priceAt(T, new Date(now))) : 0;
  const nightPrice = plan ? sum([0, 1, 2, 3, 4, 5, 6, 7].map(h => priceAt(T, new Date(2026, 0, 6, h, 30)))) / 8 : 0;
  const money = kwhYear => (plan ? kwhYear * avgPrice : null);
  const tips = [];
  const add = t => tips.push({ ...t, kwhYear: t.kwhYear != null ? Math.round(t.kwhYear) : null, costYear: t.costYear != null ? Math.round(t.costYear * 100) / 100 : null });
  const worth = (kwhYear, costYear) => (plan ? costYear >= MIN_SAVING_YEAR : kwhYear >= MIN_SAVING_YEAR * 4);
  const appKwh = id => sum(days.map(k => E.energy[k].apps?.[id] || 0));

  // 1. Shift to cheaper hours (time-of-use plans only)
  if (plan && T.mode === 'tou' && T.periods.length) {
    const prices = [T.rate, ...T.periods.map(p => p.rate)].filter(r => r > 0);
    const cheapRate = Math.min(...prices), cheap = T.periods.find(p => p.rate === cheapRate);
    const cheapest = cheapRate * (T.taxIncl === false ? 1 + (T.tax || 0) / 100 : 1);
    const hrs = p => `${String(p.from).padStart(2, '0')}:00 to ${String(p.to).padStart(2, '0')}:00${p.days !== 'all' ? ', ' + p.days : ''}`;
    const when = cheap ? `your ${cheap.name && !/^rate$/i.test(cheap.name) ? cheap.name.toLowerCase().replace(/\s*(hours?|rate|period)$/, '') + ' ' : 'cheapest '}hours (${hrs(cheap)})` : 'your cheapest hours';
    for (const s of E.sigs) {
      if (!SHIFTABLE.test(what(s)) || NOT_SHIFTABLE.test(what(s)) || s.steadyOutlet === true) continue;
      let extra = 0, outside = 0, total = 0;
      for (const k of days) { const ah = E.energy[k].ah?.[s.id]; if (!ah) continue;
        for (let h = 0; h < 24; h++) { const v = ah[h] || 0; if (!v) continue; total += v; const p = priceAt(T, at(k, h)); if (p > cheapest + 1e-9) { outside += v; extra += v * (p - cheapest); } } }
      const costYear = extra * perYear;
      if (outside < 1 || costYear < MIN_SAVING_YEAR) continue;
      add({ key: `shift:${s.id}`, kind: 'shift', sig: s.id, title: `Run the ${s.name} in cheaper hours`,
        text: `In the last ${days.length} days it used ${outside.toFixed(1)} kWh (${Math.round(outside / total * 100)}% of its energy) outside your cheapest hours. Starting it in ${when} instead would save about this much.`,
        kwhYear: null, costYear });
    }
  }

  // 2. Standby: measured appliances drawing power while idle; switching them off overnight (8 hours)
  for (const s of E.sigs) {
    if (!s.metered || s.estimated || !(s.standbyW >= Math.max(1, E.settings.standbyThreshold || 1))) continue;
    const kwhYear = s.standbyW * 8 * 365 / 1000, costYear = plan ? kwhYear * nightPrice : null;
    if (!worth(kwhYear, costYear)) continue;
    add({ key: `standby:${s.id}`, kind: 'standby', sig: s.id, title: `${s.name} uses ${Math.round(s.standbyW * 10) / 10} W while idle`,
      text: `That's ${Math.round(s.standbyW * 24 * 365 / 1000)} kWh a year doing nothing. Switching it off overnight (midnight to 8 am), with a plug schedule or an automation, saves about this much.`, kwhYear, costYear });
  }

  // 3. Always-on load that went up: compared with the week before
  const bases = keys.map(k => E.energy[k]?.base).filter(v => v != null), base = E.baseLoad(now - 86400e3, now);
  if (base != null && bases.length >= 5) {
    const before = median(bases.slice(1, 8).length ? bases.slice(1, 8) : bases), jump = base - before;
    if (jump >= 30 && jump / before >= 0.15) {
      const kwhYear = jump * 8.76;
      if (worth(kwhYear, money(kwhYear))) add({ key: 'base-up', kind: 'base', title: `Always-on load is up ${Math.round(jump)} W`,
        text: `About ${Math.round(base)} W is always on now, against ${Math.round(before)} W in the week before. Something new is probably left on or plugged in: finding it saves about this much.`, kwhYear, costYear: money(kwhYear) });
    }
  }
  if (base != null && base >= 150) {
    const kwhYear = base * 8.76;
    add({ key: 'base', kind: 'info', title: `About ${Math.round(base)} W is always on`, info: true,
      text: `That's ${Math.round(kwhYear)} kWh${plan ? `, about ${E.settings.currency}${Math.round(kwhYear * avgPrice)}` : ''} a year before anything is switched on: fridges, routers, pumps and things on standby. Every 10 W less saves about ${plan ? `${E.settings.currency}${(10 * 8.76 * avgPrice).toFixed(0)}` : '88 kWh'} a year.`, kwhYear: null, costYear: null });
  }

  // 4. Using more than the month before (needs two windows of readings)
  const prevKeys = []; for (let i = WINDOW + 1; i <= 2 * WINDOW; i++) prevKeys.push(dayKey(now - i * 86400e3));
  const prevDays = prevKeys.filter(k => E.energy[k]);
  if (days.length >= 14 && prevDays.length >= 14) {
    for (const s of E.sigs) {
      const a = appKwh(s.id) / days.length, b = sum(prevDays.map(k => E.energy[k].apps?.[s.id] || 0)) / prevDays.length;
      if (b < 0.1 || a < b * 1.2) continue;
      const kwhYear = (a - b) * 365;
      if (!worth(kwhYear, money(kwhYear))) continue;
      add({ key: `more:${s.id}`, kind: 'more', sig: s.id, title: `${s.name} is using ${Math.round((a / b - 1) * 100)}% more`,
        text: `${a.toFixed(2)} kWh a day over the last ${days.length} days, against ${b.toFixed(2)} kWh the month before. Back to the old level would save about this much.`, kwhYear, costYear: money(kwhYear) });
    }
  }

  // 5. Runs getting longer than they used to (a likely cause by appliance type)
  for (const s of E.sigs) {
    const r = s.recentRuns || []; if (r.length < 10) continue;
    const late = median(r.slice(-5)), early = median(r.slice(0, -5));
    if (!(early >= 60) || late < early * 1.3) continue;
    const cause = (LONGER.find(([re]) => re.test(what(s))) || [, 'worth a look'])[1];
    const kwhYear = appKwh(s.id) * perYear * (1 - early / late);
    if (!worth(kwhYear, money(kwhYear))) continue;
    add({ key: `longer:${s.id}`, kind: 'longer', sig: s.id, title: `${s.name} runs are ${Math.round((late / early - 1) * 100)}% longer`,
      text: `Its last runs took about ${Math.round(late / 60)} min, against ${Math.round(early / 60)} min before: ${cause}. Back to normal would save about this much.`, kwhYear, costYear: money(kwhYear) });
  }

  // 6. Cost of each run (information: helps decide on full loads, line-drying, eco programmes)
  if (plan) for (const s of E.sigs) {
    if (s.steadyOutlet === true) continue;
    const runs = E.events.filter(e => e.sig === s.id && e.dur > 0 && e.dir === 'off' && days.includes(dayKey(e.t))).length;
    if (runs < 3) continue;
    let cost = 0; for (const k of days) { const ah = E.energy[k].ah?.[s.id]; if (ah) for (let h = 0; h < 24; h++) cost += (ah[h] || 0) * priceAt(T, at(k, h)); }
    const per = cost / runs; if (per < 0.2) continue;
    add({ key: `run:${s.id}`, kind: 'info', sig: s.id, info: true, title: `Each ${s.name} run costs about ${E.settings.currency}${per.toFixed(2)}`,
      text: `${runs} runs in the last ${days.length} days, ${E.settings.currency}${cost.toFixed(2)} in all${SHIFTABLE.test(what(s)) ? '. Full loads and eco programmes make each run count' : ''}.`, kwhYear: null, costYear: null });
  }

  // 7. Much of the energy isn't linked to an appliance
  const other = sum(days.map(k => E.energy[k].other || 0)), total = sum(days.map(k => E.energy[k].total || 0)), waiting = E.patterns().length;
  if (total > 1 && other / total >= 0.4) add({ key: 'other', kind: 'info', info: true, title: `${Math.round(other / total * 100)}% of your electricity isn't linked to an appliance`,
    text: `Tips can only cover what's named or measured.${waiting ? ` ${waiting} repeating step${waiting === 1 ? ' is' : 's are'} waiting to be named under Appliances.` : ''} Tracking big users with a smart plug or a Shelly makes them exact.`, kwhYear: null, costYear: null });

  // savings first (largest first), then information; a dismissed tip stays hidden unless its saving changed a lot
  const dismissed = E.settings.tipsDismissed || {};
  for (const t of tips) { const d = dismissed[t.key]; const v = t.costYear ?? t.kwhYear;
    t.hidden = d != null && (t.info || v == null || (Math.abs(v - d) < Math.max(10, d * 0.5))); }
  tips.sort((a, b) => (!!a.info - !!b.info) || ((b.costYear ?? b.kwhYear ?? 0) - (a.costYear ?? a.kwhYear ?? 0)));
  return { tips, days: days.length, plan };
}
