// node test/insights-unit.mjs - Ways to save, on made-up history: shifting to cheap hours, standby, the always-on load going up,
// using more than the month before, longer runs, cost per run, too much unexplained; no tips without enough readings;
// dismissing, and a dismissed tip coming back only when its saving changes a lot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, dayKey } from '../lib/engine.js';
import { insights } from '../lib/insights.js';

let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const mk = () => new Engine({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-in-')), 'state.json'), log: quiet });
const NOW = new Date(2026, 10, 18, 12).getTime(), DAY = 86400e3;
const hz = () => Array(24).fill(0);
const TOU = { mode: 'tou', rate: 0.30, periods: [{ name: 'Night', from: 21, to: 7, rate: 0.15, days: 'all' }, { name: 'Peak', from: 17, to: 21, rate: 0.40, days: 'all' }] };
// a home with `days` days of history: dryer 1.5 kWh at 6 pm each day, fridge 0.1 kWh every hour, 6 kWh unexplained
function home(e, days = 30, { from = 1, dryer = 1.5, fridgeHour = 0.1 } = {}) {
  const dry = e.sigs.find(s => s.name === 'Dryer') || e.newSig('Dryer', { icon: 'dry_cleaning', watts: 2200 });
  const fr = e.sigs.find(s => s.name === 'Fridge') || e.newSig('Fridge', { icon: 'kitchen', watts: 120 });
  for (let i = from; i < from + days; i++) {
    const k = dayKey(NOW - i * DAY), d = e.energy[k] = { total: 0, apps: {}, other: 6, peak: 3000, peakT: 0, h: hz(), ah: {}, oh: hz(), base: 180 };
    const ad = (d.ah[dry.id] = hz()); ad[18] = dryer; d.apps[dry.id] = dryer;
    const af = (d.ah[fr.id] = hz().map(() => fridgeHour)); d.apps[fr.id] = fridgeHour * 24;
    for (let h = 0; h < 24; h++) { d.oh[h] = 0.25; d.h[h] = ad[h] + af[h] + 0.25; }
    d.total = d.h.reduce((a, b) => a + b, 0);
  }
  return { dry, fr };
}
const tip = (r, kind) => r.tips.find(t => t.kind === kind);

await ok('no tips until there are a few days of readings', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); home(e, 2);
  const r = insights(e, NOW); assert.equal(r.tips.length, 0); assert.equal(r.needDays, 3);
});

await ok('shift to cheaper hours: the dryer at 6 pm, worked out from its own hours and the plan; never the fridge', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); home(e, 30);
  const t = insights(e, NOW).tips.find(x => x.key.startsWith('shift:'));
  assert.ok(t, 'a shift tip'); assert.match(t.title, /Dryer/);
  // 1.5 kWh a day at 0.40 instead of 0.15, for a year
  assert.ok(Math.abs(t.costYear - 1.5 * 0.25 * 365) < 0.5, t.costYear);
  assert.match(t.text, /in your night hours \(21:00 to 07:00\)/);
  assert.ok(!insights(e, NOW).tips.some(x => x.key.startsWith('shift:') && /Fridge/.test(x.title)));
  e.setSettings({ tariff: { mode: 'single', rate: 0.3 } });
  assert.ok(!insights(e, NOW + 61e3).tips.some(x => x.kind === 'shift'), 'no shifting on a flat rate');
});

await ok('standby of a measured appliance, priced at night rates', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); home(e, 10);
  e.newSig('TV', { metered: true, devId: 'shrpc:tv:0', standbyW: 12 });
  const t = tip(insights(e, NOW), 'standby');
  assert.ok(t); assert.ok(Math.abs(t.kwhYear - 12 * 8 * 365 / 1000) <= 1); assert.ok(Math.abs(t.costYear - 35.04 * (7 * 0.15 + 0.30) / 8) < 0.05, t.costYear); // midnight to 8 am: 7 night hours, 7-8 am at the base rate
});

await ok('always-on load up on the week before; always-on shown with what 10 W is worth', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); home(e, 10);
  for (let m = 0; m < 300; m++) e.minutes.push([NOW - m * 60e3, 300]);
  const r = insights(e, NOW);
  assert.match(tip(r, 'base').title, /up 120 W/);
  assert.ok(r.tips.some(t => t.key === 'base' && t.info));
});

await ok('using more than the month before, and runs getting longer with a likely cause', () => {
  const e = mk(); e.setSettings({ tariff: TOU });
  const { fr } = home(e, 30, { from: 31, fridgeHour: 0.05 }); home(e, 30, { from: 1, fridgeHour: 0.1 });
  const r = insights(e, NOW);
  const more = r.tips.find(t => t.key === `more:${fr.id}`); assert.ok(more, JSON.stringify(r.tips.map(t => t.key))); assert.match(more.title, /100% more/);
  fr.recentRuns = [1200, 1200, 1200, 1200, 1200, 1800, 1800, 1800, 1800, 1800];
  const r2 = insights(e, NOW + 61e3), longer = r2.tips.find(t => t.key === `longer:${fr.id}`);
  assert.ok(longer); assert.match(longer.text, /door seal/); assert.match(longer.title, /50% longer/);
});

await ok('cost of each run, and a nudge when much of the energy isn\'t linked to anything', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); const { dry } = home(e, 10);
  for (let i = 1; i <= 5; i++) e.events.push({ id: 'r' + i, t: NOW - i * DAY + 3600e3, d: -2200, dir: 'off', sig: dry.id, dur: 2400 });
  const r = insights(e, NOW);
  const run = r.tips.find(t => t.key === `run:${dry.id}`); assert.ok(run); assert.match(run.title, /\$1\.20|\$1\.2/);
  assert.ok(r.tips.find(t => t.key === 'other'));
  assert.ok(r.tips.findIndex(t => t.info) > r.tips.findIndex(t => !t.info), 'savings before information');
});

await ok('without a plan: savings in kWh, no money', () => {
  const e = mk(); home(e, 10); e.newSig('TV', { metered: true, devId: 'shrpc:tv:0', standbyW: 12 });
  const t = tip(insights(e, NOW), 'standby'); assert.ok(t); assert.equal(t.costYear, null); assert.ok(t.kwhYear > 30);
});

await ok('a dismissed tip stays hidden, and comes back only when its saving changes a lot', () => {
  const e = mk(); e.setSettings({ tariff: TOU }); home(e, 30);
  const key = insights(e, NOW).tips.find(x => x.kind === 'shift').key;
  e.insightCache = null; const realNow = Date.now; Date.now = () => NOW;
  try {
    e.dismissTip(key);
    assert.equal(e.insights(NOW).tips.find(x => x.key === key).hidden, true);
    home(e, 30, { dryer: 4 }); e.changed(); // the dryer now uses far more at peak
    assert.equal(e.insights(NOW).tips.find(x => x.key === key).hidden, false);
    e.dismissTip(null); assert.deepEqual(e.settings.tipsDismissed, {});
  } finally { Date.now = realNow; }
});
console.log(`${n} passed`);
