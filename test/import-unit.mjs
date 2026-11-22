// node test/import-unit.mjs - backups: saved on this computer, listed, and restored (from the list or a chosen file).
// fixtures/backup.json is a made-up backup in this plugin's own format.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, dayKey } from '../lib/engine.js';
import { importBackup, listBackups, saveBackup, readBackup } from '../lib/import.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bk = JSON.parse(fs.readFileSync(path.join(FX, 'backup.json'), 'utf8'));
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const mk = () => new Engine({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-i-')), 'state.json'), log: quiet });

await ok('a backup file: appliances with their ids, tiles, history, tracked devices and the plan come back', () => {
  const e = mk(), r = importBackup(e, bk);
  const by = Object.fromEntries(e.sigs.map(s => [s.name, s])), old = Object.fromEntries(bk.sigs.map(s => [s.name, s]));
  assert.equal(by.Kettle.id, old.Kettle.id, 'same id, so the same Apple Home tiles');
  assert.equal(by.Kettle.statusType, old.Kettle.statusType); assert.equal(by.Kettle.room, 'Kitchen');
  assert.equal(by['Garage heater'].devId, 'shk:shelly1-TEST01:1'); assert.equal(by['Garage heater'].metered, true);
  assert.equal(by['Hallway lamp'].relink, true);
  assert.equal(by.Grill.devId, 'mhub:42:1'); assert.equal(by.Grill.metered, true);
  assert.deepEqual(e.matterDevices.map(m => m.nodeId).sort(), ['42', '44']);
  assert.equal(e.events.length, bk.events.length); assert.equal(Object.keys(e.energy).length, Object.keys(bk.energy).length);
  assert.deepEqual(e.settings.shellyHosts, ['192.168.1.51']);
  assert.equal(r.counts.appliances, 4); assert.equal(r.counts.matter, 2);
});

await ok('a day both sides have keeps the fuller record (never added together); Apple Home totals never go down', () => {
  const e = mk(), k = Object.keys(bk.energy)[0];
  e.energy[k] = { total: 1e6, apps: {}, other: 1e6, peak: 5000, peakT: 1 }; e.otherKwh = 1e6;
  importBackup(e, bk);
  assert.equal(e.energy[k].total, 1e6, 'the fuller day stays'); assert.equal(e.otherKwh, 1e6);
  const e2 = mk(); e2.energy[k] = { total: 0.001, apps: {}, other: 0.001, peak: 1, peakT: 1 };
  importBackup(e2, bk); assert.equal(e2.energy[k].total, bk.energy[k].total, 'the backup\'s fuller day replaces it');
});

await ok('importing twice doubles nothing, and anything that isn\'t this plugin\'s backup is refused', () => {
  const x2 = structuredClone(bk); x2.energy['2026-01-01'] = { total: 7, apps: {}, other: 7, peak: 900, peakT: 1 };
  const e = mk(); importBackup(e, x2);
  const ev = e.events.length, sigs = e.sigs.length, m = e.matterDevices.length, tot = JSON.stringify(e.energy);
  importBackup(e, x2);
  assert.equal(e.events.length, ev); assert.equal(e.sigs.length, sigs); assert.equal(e.matterDevices.length, m); assert.equal(JSON.stringify(e.energy), tot);
  for (const bad of [{ hello: 1 }, null, { sigs: [] }, { format: 'other', sigs: [] }]) assert.throws(() => importBackup(e, bad), /isn't a backup made by this plugin/);
  importBackup(e, { format: 'home-energy-1', sigs: [{ id: '../../x', name: 'Bad' }, { id: 'ok1', name: '<b>Fine</b>', icon: 'javascript:alert(1)' }], energy: { nope: {}, '2026-01-02': { total: 'x' } } });
  assert.deepEqual(e.sigs.filter(s => s.id === 'ok1').map(s => [s.name, s.icon]), [['<b>Fine</b>', null]]);
  assert.ok(!e.sigs.some(s => s.id === '../../x')); assert.ok(!e.energy.nope);
});

await ok('a backup made here goes back in: tracked devices, run learning, Matter devices, settings; never a web PIN', async () => {
  const { hashPin } = await import('../lib/web-auth.js');
  const a = mk();
  const s = a.newSig('Washer', { metered: true, devId: 'shrpc:wash1:0', runW: 8, runWSet: true, learn: { finishSec: 720, cycles: 3 }, room: 'Laundry', icon: 'none' });
  a.newSig('Lamp', { metered: true, devId: 'shk:relay1:1', estimated: true, estW: 9 });
  a.matterDevices.push({ id: 'mtr-x', name: 'Grill plug', nodeId: '42', status: 'connected', product: 'IKEA' });
  a.devEst['shk:relay1:1'] = { ws: [9, 9, 9], n: 3, skip: 0, small: 0, t: 1 };
  a.setSettings({ other: { on: true, name: 'Everything else' }, tariff: { mode: 'single', rate: 0.25 } }); a.hideDevice('shg1:aabb:light0');
  a.energy[dayKey(Date.now())] = { total: 3, apps: { [s.id]: 1 }, other: 2, peak: 2000, peakT: 1, h: Array(24).fill(0.125), ah: { [s.id]: Array(24).fill(1 / 24) } };
  s.progs = [{ id: 'prog1', name: 'Eco' }]; s.cycles = [{ id: 'cyc1', t: 1, dur: 9000, kwh: 1.1, prog: 'prog1', prof: [80, 2000, null, 80] }, { id: 'bad', prog: 'nope', prof: [] }];
  a.settings.web.pin = hashPin('4826');
  const backup = JSON.parse(JSON.stringify(a.toData())); // the file still carrying a PIN must not bring it in
  const b = mk(); const r = importBackup(b, backup);
  const w = b.sigs.find(x => x.name === 'Washer');
  assert.equal(w.devId, 'shrpc:wash1:0'); assert.equal(w.metered, true); assert.equal(b.runLevel(w), 8, 'your own running level kept');
  assert.equal(w.learn.finishSec, 720); assert.equal(w.learn.cycles, 3); assert.equal(w.icon, 'none'); assert.equal(w.room, 'Laundry');
  const l = b.sigs.find(x => x.name === 'Lamp'); assert.equal(l.estimated, true); assert.equal(l.estW, 9);
  assert.equal(b.matterDevices[0].nodeId, '42'); assert.equal(b.devEst['shk:relay1:1'].ws.length, 3);
  assert.equal(b.settings.other.name, 'Everything else'); assert.deepEqual(b.settings.devHidden, ['shg1:aabb:light0']); assert.equal(b.settings.tariff.rate, 0.25);
  assert.equal(b.energy[dayKey(Date.now())].ah[s.id].length, 24, 'hourly figures per appliance kept');
  assert.equal(b.settings.web.pin, null, 'no PIN from a file'); assert.equal(r.counts.appliances, 2);
  assert.equal(b.finishSecs(w), 720, 'learned finish wait restored');
  assert.deepEqual(w.progs, [{ id: 'prog1', name: 'Eco' }]); assert.deepEqual(w.cycles.map(c => [c.id, c.prof]), [['cyc1', [80, 2000, null, 80]]], 'learned cycles restored, junk dropped');
});

await ok('backups are saved on this computer, newest first, the newest 10 kept, and only those can be read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-bk-'));
  assert.deepEqual(listBackups(dir), []);
  const names = []; for (let i = 0; i < 12; i++) names.push(saveBackup(dir, { format: 'home-energy-1', sigs: [], i }, new Date(2026, 10, 18, 10, 0, i)));
  const list = listBackups(dir);
  assert.equal(list.length, 10); assert.equal(list[0].name, names[11]); assert.equal(list.at(-1).name, names[2]);
  assert.equal(readBackup(dir, names[11]).i, 11);
  assert.throws(() => readBackup(dir, names[0]), /isn't one of/);
  assert.throws(() => readBackup(dir, '../state.json'), /isn't one of/);
  fs.writeFileSync(path.join(dir, 'backups', 'notes.json'), '{}'); assert.equal(listBackups(dir).length, 10);
});
console.log(`${n} passed`);
