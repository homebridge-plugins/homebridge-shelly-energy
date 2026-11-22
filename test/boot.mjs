// node test/boot.mjs [seconds] - starts the real plugin (index.js) against a stand-in Homebridge API, a stand-in Shelly EM,
// a stand-in Shelly Gen2 plug and the stand-in Matter controller, then drives it through the settings-page link the way the
// page does: view, settings, a Matter device, import, naming. Fails on a crash, an error in the log, or a wrong answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, fakeLog, PlatformAccessory, uuid } from './fake-homebridge.mjs';
import { startFakeEm, startFakeGen2 } from './fake-shelly.mjs';
import { callPlugin } from '../lib/control.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HE_MATTER_WORKER = path.join(HERE, 'fake-matter-worker.mjs');
const { default: plugin } = await import('../lib/index.js');
const secs = Math.max(8, +(process.argv[2] || 12));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-boot-')), cfgPath = path.join(dir, 'config.json');
const block = { platform: 'ShellyHomeEnergy', name: 'Shelly Home Energy', host: '127.0.0.1:18801', channel: 'em1:0', _bridge: { username: '0E:00:00:00:00:01', port: 51999, matter: { port: 5541 } } };
// another plugin's child bridge with the same bridge ID and Matter port: the plugin must say exactly what to fix
fs.writeFileSync(cfgPath, JSON.stringify({ bridge: { name: 'Test' }, platforms: [block, { platform: 'SomethingElse', name: 'Other plugin', _bridge: { ...block._bridge } }] }));
const em = startFakeEm(18801), plug = startFakeGen2(18802, { name: 'Dryer' });
const api = fakeApi({ storage: dir, configPath: cfgPath }), log = fakeLog();
let crashed = null; process.on('uncaughtException', e => { crashed = e; }); process.on('unhandledRejection', e => { crashed = e; });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(100); } throw new Error('timed out'); };
const call = (a, args) => callPlugin(path.join(dir, 'home-energy'), a, args);

plugin(api);
const platform = new api.Platform(log, block, api);
// a cached HAP tile this plugin didn't publish: must survive start-up untouched
const leak = new PlatformAccessory('Water leak', uuid.generate('shelly-appliances-faucet:__water_leak__')); leak.context.applianceId = '__water_leak__';
platform.configureAccessory(leak);
api.emit('didFinishLaunching');
let failed = null;
try {
  await until(() => fs.existsSync(path.join(dir, 'home-energy', 'control.json')));
  let v = await call('view');
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && /same bridge ID as "Other plugin"/.test(m)), 'warns about the clashing bridge ID');
  assert.ok(log.lines.some(([l, m]) => l === 'warn' && /Matter port 5541 is also used by "Other plugin"/.test(m)), 'warns about the clashing Matter port');
  assert.equal(v.plugin.name, 'Homebridge Shelly Energy');
  assert.deepEqual(v.backups, []);
  await until(async () => (await call('view')).em.ok);
  // whole-house readings and a step
  em.st.w = 350; await wait(3000); em.st.w = 2350; await wait(4000);
  v = await call('view'); assert.ok(v.now.p >= 2300, JSON.stringify(v.now));
  // a Shelly address off the home network is refused; the plug is read
  await assert.rejects(call('setSettings', { shellyHosts: '8.8.8.8' }), /home network/);
  await call('setSettings', { shellyHosts: '127.0.0.1:18802' });
  await until(async () => (await call('view')).devices.some(d => d.name === 'Dryer'));
  // a Matter device
  await assert.rejects(call('matterAdd', { name: 'X', code: 'hello' }), /pairing code/);
  const mid = await call('matterAdd', { name: 'Grill plug', code: '12345678901' });
  await until(async () => (await call('view')).matter.find(m => m.id === mid)?.status === 'connected');
  // restore a backup file; its appliances' tiles come back with the same identities
  const bk = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'backup.json'), 'utf8'));
  const r = await call('importFile', { data: bk, name: 'backup.json' });
  assert.equal(r.counts.appliances, 4);
  await wait(500);
  const kettle = bk.sigs.find(s => s.name === 'Kettle');
  assert.ok(api.rec.mReg.some(a => a.UUID === uuid.generate(`shelly-appliances:${kettle.id}`)), 'Kettle outlet on Matter');
  assert.ok(api.rec.hapReg.some(a => a.UUID === uuid.generate(`shelly-appliances-faucet:${kettle.id}`)), 'Kettle running tile');
  assert.equal(api.rec.hapUnreg.length, 0, 'a cached tile this plugin didn\'t publish is never removed');
  // summary, export
  const s = await call('summary', { days: 7 }); assert.ok(s.total.kwh > 0);
  const ex = await call('exportData'); assert.equal(ex.sigs.length, 4); assert.ok(!JSON.stringify(ex).includes('"pin":{'), 'no PIN in a backup');
  // the backup is also kept on this computer, listed, and imports again
  assert.ok(fs.existsSync(path.join(dir, 'home-energy', 'backups', ex.savedAs)), 'backup saved on disk');
  v = await call('view'); assert.deepEqual(v.backups.map(b => b.name), [ex.savedAs]);
  assert.equal((await call('importBackup', { name: ex.savedAs })).counts.appliances, 4);
  await assert.rejects(call('importBackup', { name: '../state.json' }), /isn't one of the backups/);
  await wait(Math.max(0, secs * 1000 - 9000));
} catch (e) { failed = e; }
api.emit('shutdown'); await wait(300);
em.close(); plug.close();
const saved = fs.existsSync(path.join(dir, 'home-energy', 'state.json'));
const bad = log.lines.filter(([l]) => l === 'error').map(([, m]) => m);
console.log(`ran ${secs}s · ${log.lines.length} log lines · errors ${bad.length} · saved ${saved}`);
for (const [l, m] of log.lines.filter(([l]) => process.env.VERBOSE || l !== "info")) console.log(`  ${l}: ${m.slice(0, 200)}`);
if (failed) console.log('FAIL:', failed.stack || failed);
if (crashed) console.log('CRASH:', crashed.stack || crashed);
const pass = !failed && !crashed && !bad.length && saved && !fs.existsSync(path.join(dir, 'home-energy', 'control.json'));
console.log(pass ? 'boot passed' : 'boot FAILED');
setTimeout(() => process.exit(pass ? 0 : 1), 200);
