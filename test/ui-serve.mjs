// node test/ui-serve.mjs <port> - the settings page in a browser without Homebridge: runs the real plugin (index.js) on
// stand-ins (Shelly EM, a Gen2 plug, a HomeKit-firmware relay, the Matter controller), the page's real server-side handlers,
// and a stand-in for the Homebridge UI's `homebridge` object in the page. Used by test/ui-test.py.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeApi, fakeLog } from './fake-homebridge.mjs';
import { startFakeEm, startFakeGen1, startFakeGen2, startFakeShelly } from './fake-shelly.mjs';
import { makeHandlers } from '../lib/homebridge-ui/handlers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), port = +(process.argv[2] || 8599);
process.env.HE_MATTER_WORKER = path.join(HERE, 'fake-matter-worker.mjs');
const { default: plugin } = await import('../lib/index.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-ui-')), cfgPath = path.join(dir, 'config.json');
// files the browser test chooses with "Import a backup file…" (it knows this folder from the port)
const files = path.join(os.tmpdir(), `he-ui-files-${port}`); fs.rmSync(files, { recursive: true, force: true }); fs.mkdirSync(files);
fs.copyFileSync(path.join(HERE, 'fixtures', 'backup.json'), path.join(files, 'saved.json'));
// a third file: a month of made-up history with a dryer at 6 pm and a time-of-use plan, so Ways to save has something to show
{
  const x = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'backup.json'), 'utf8')), key = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  x.sigs.push({ id: 'testdryer01', name: 'Dryer', icon: 'dry_cleaning', watts: 2200, kwh: 40, runs: 30, stages: [] });
  x.settings.tariff = { mode: 'tou', rate: 0.30, periods: [{ name: 'Night', from: 21, to: 7, rate: 0.15, days: 'all' }, { name: 'Peak', from: 17, to: 21, rate: 0.40, days: 'all' }] };
  x.energy = {};
  for (let i = 1; i <= 30; i++) { const h = Array(24).fill(0.3), ah = Array(24).fill(0); ah[18] = 1.5; h[18] += 1.5;
    x.energy[key(Date.now() - i * 86400e3)] = { total: h.reduce((a, b) => a + b, 0), apps: { testdryer01: 1.5 }, other: 7.2, peak: 2500, peakT: 0, h, ah: { testdryer01: ah }, oh: Array(24).fill(0.3), base: 250 }; }
  fs.writeFileSync(path.join(files, 'month.json'), JSON.stringify(x));
}
let config = [{ platform: 'ShellyHomeEnergy', name: 'Shelly Home Energy', host: `127.0.0.1:${port + 1}`, channel: 'em1:0', webPort: port + 5, _bridge: { username: '0E:00:00:00:00:02', port: 51998, matter: { port: 5542 } } }];
fs.writeFileSync(cfgPath, JSON.stringify({ bridge: { name: 'Test' }, platforms: config }));
const em = startFakeEm(port + 1), plug = startFakeGen2(port + 2, { name: 'Dryer' }), relay = startFakeShelly(port + 3, { name: 'Garage heater' });
// Find Shellys looks at these instead of this computer's network: the two above (added during the test), a Gen1 relay not added
// yet, a Shelly with a password, and the meter (not a Shelly by /shelly here, so it isn't listed)
startFakeGen1(port + 6, { type: 'SHSW-PM', name: 'Workshop' }); startFakeGen2(port + 7, { password: true, id: 'shellyplus1-locked' });
// a device whose name is HTML: must show as text, never run
startFakeGen1(port + 8, { type: 'SHSW-1', name: '<img src=x onerror="window.__pwned=1">Evil', mac: 'A1B2C3D4E5F7' });
process.env.HE_SCAN_HOSTS = [1, 2, 3, 6, 7, 8].map(n => `127.0.0.1:${port + n}`).join(' ');
// the house: 300 W, a 1.2 kW load on for 20 s every 70 s, so steps to name appear quickly
let k = 0; setInterval(() => { k = (k + 1) % 70; em.st.w = 300 + (k < 20 ? 1200 : 0) + (relay.st.state ? 1500 : 0) + (plug.st.on[0] ? plug.st.w[0] : 0); }, 1000);
setInterval(() => { relay.st.state = !relay.st.state; }, 45000);
const api = fakeApi({ storage: dir, configPath: cfgPath }), log = fakeLog();
plugin(api);
new api.Platform(log, config[0], api);
api.emit('didFinishLaunching');
const H = makeHandlers(dir);
const page = fs.readFileSync(path.join(HERE, '..', 'lib', 'homebridge-ui', 'public', 'index.html'), 'utf8');
const stub = `<script>
window.homebridge = {
  async request(route, payload) { const r = await fetch('/hb', { method: 'POST', body: JSON.stringify({ route, payload }) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; },
  toast: { success: (m, t) => window.__toasts.push(['ok', m]), error: (m, t) => window.__toasts.push(['error', m]) },
  showSpinner() {}, hideSpinner() {},
  async getPluginConfig() { return (await fetch('/config')).json(); },
  async updatePluginConfig(c) { await fetch('/config', { method: 'POST', body: JSON.stringify(c) }); return c; },
  async savePluginConfig() {},
};
window.__toasts = [];
</script>`;
http.createServer((req, res) => {
  const body = () => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  // like the Homebridge UI: the page runs in a sandboxed frame without allow-modals or allow-downloads, so confirm(), prompt() and downloads are blocked
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0"><iframe id="ui" src="/inner" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style="border:0;width:100%;height:100vh"></iframe></body></html>`); }
  if (req.url === '/inner') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${stub}</head><body style="font-family:sans-serif;max-width:1000px;margin:1rem auto">${page}</body></html>`); }
  if (req.url === '/hb') return body().then(async b => { const { route, payload } = JSON.parse(b); try { json({ result: await H[route](payload) }); } catch (e) { json({ error: e.message }); } });
  if (req.url === '/config' && req.method === 'GET') return json(config);
  if (req.url === '/config') return body().then(b => { config = JSON.parse(b); json(true); });
  if (req.url === '/log') return json(log.lines);
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`settings page on http://127.0.0.1:${port}/ (Shelly plug at 127.0.0.1:${port + 2}, relay at 127.0.0.1:${port + 3})`));
process.on('SIGTERM', () => { api.emit('shutdown'); process.exit(0); });
