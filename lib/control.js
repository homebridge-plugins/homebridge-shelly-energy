// The link between the running plugin and its settings page in the Homebridge UI. No network port: an HTTP server on a
// socket file only this user can open, plus a random key in control.json next to it (also only readable by this user).
// The settings page's own server (homebridge-ui/server.js) reads that file and passes each request on.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 80 * 1024 * 1024; // an import file can be large

// Unix socket paths are limited to about 104 bytes on macOS: use a short one in the temp folder if the storage path is long
function socketPath(dataDir) {
  const p = path.join(dataDir, 'control.sock');
  if (process.platform === 'win32') return `\\\\.\\pipe\\home-energy-${crypto.createHash('sha1').update(dataDir).digest('hex').slice(0, 12)}`;
  return Buffer.byteLength(p) < 100 ? p : path.join(os.tmpdir(), `home-energy-${crypto.createHash('sha1').update(dataDir).digest('hex').slice(0, 12)}.sock`);
}

export function startControl({ dataDir, actions, log }) {
  const sock = socketPath(dataDir), key = crypto.randomBytes(24).toString('hex'), info = path.join(dataDir, 'control.json');
  try { if (process.platform !== 'win32') fs.rmSync(sock, { force: true }); } catch {}
  const server = http.createServer((req, res) => {
    const reply = (code, body) => { const s = JSON.stringify(body ?? null); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };
    const given = String(req.headers['x-key'] || '');
    if (req.method !== 'POST' || req.url !== '/api' || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return reply(403, { error: 'Not allowed' });
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reply(413, { error: 'That file is too large.' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reply(400, { error: 'Bad request' }); }
      const fn = actions[body?.action];
      if (typeof fn !== 'function') return reply(400, { error: `Unknown action "${String(body?.action).slice(0, 40)}"` });
      try { reply(200, { ok: true, result: await fn(body.args || {}) }); }
      catch (e) { if (!e.user) log.debug?.(`Settings page action ${body.action}: ${e.stack || e}`); reply(200, { ok: false, error: String(e.message || e).slice(0, 600) }); }
    });
  });
  server.on('error', e => log.warn(`The settings page link couldn't start (${e.message}). The plugin keeps working; restart Homebridge to try again.`));
  server.listen(sock, () => {
    try { if (process.platform !== 'win32') fs.chmodSync(sock, 0o600); } catch {}
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(info, JSON.stringify({ socket: sock, key, pid: process.pid, at: Date.now() }), { mode: 0o600 });
  });
  return { close: () => { try { server.close(); } catch {} try { fs.rmSync(info, { force: true }); if (process.platform !== 'win32') fs.rmSync(sock, { force: true }); } catch {} }, sock };
}

/** Used by homebridge-ui/server.js (and the tests): send one action to the running plugin. */
export function callPlugin(dataDir, action, args = {}, timeout = 20000) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8')); }
  catch { return Promise.reject(Object.assign(new Error('The plugin isn\'t running. Check it\'s enabled and that its child bridge is running, then reload this page.'), { notRunning: true })); }
  const body = JSON.stringify({ action, args });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: info.socket, path: '/api', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Key': info.key }, timeout }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('The plugin gave an unreadable answer.')); }
        if (res.statusCode !== 200) return reject(new Error(j?.error || `HTTP ${res.statusCode}`));
        j.ok ? resolve(j.result) : reject(new Error(j.error)); });
    });
    req.on('timeout', () => req.destroy(new Error('The plugin didn\'t answer in time.')));
    req.on('error', e => reject(['ENOENT', 'ECONNREFUSED'].includes(e.code) ? Object.assign(new Error('The plugin isn\'t running. Check it\'s enabled and that its child bridge is running, then reload this page.'), { notRunning: true }) : e));
    req.end(body);
  });
}
