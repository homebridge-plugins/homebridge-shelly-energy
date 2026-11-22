// The plugin's own web page (http://<this computer>:8591/): the same page as in the Homebridge UI, in a full browser window.
// Only for the home network: requests from other addresses, or naming a host that isn't a home-network name, are refused
// (the second stops a website you visit from reaching this page through your browser). Everything but the page itself
// needs a PIN, set on the plugin's settings page in the Homebridge UI. The page can't change the PIN or the web settings.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLanHost } from './hosts.js';
import { pinOk, newSession, sessionOk, endSession } from './web-auth.js';
import { makeHandlers, ACTIONS } from '../homebridge-ui/handlers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'homebridge-ui', 'public', 'index.html');
const MAX_BODY = 2 * 1024 * 1024;         // files arrive in 256 KB pieces
const COOKIE = 'he_session', COOKIE_DAYS = 180;
const FAILS = 5, LOCK_MS = 10 * 60e3;     // wrong PINs from one address before it has to wait
const WEB_ACTIONS = new Set([...ACTIONS].filter(a => !a.startsWith('web')));

const remoteOf = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const hostOf = req => String(req.headers.host || '').replace(/:\d{1,5}$/, '').replace(/^\[|\]$/g, '').toLowerCase();
const cookieOf = req => { const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(req.headers.cookie || ''); return m ? m[1] : null; };

export function startWeb({ port, engine, actions, storagePath, log, onSaveNeeded = () => {} }) {
  const handlers = makeHandlers(storagePath, (dir, action, args) => {
    if (!WEB_ACTIONS.has(action) && action !== 'exportData' && action !== 'importFile') throw new Error('Not allowed from the web page.');
    return actions[action](args || {});
  }, WEB_ACTIONS);
  const fails = new Map(); // address -> { n, until }
  let page = null;
  const html = () => page ??= wrap(fs.readFileSync(PAGE, 'utf8'));
  const web = () => engine.settings.web;

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json', extra = {}) => {
      const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", ...extra });
      res.end(s);
    };
    try {
      if (!isLanHost(remoteOf(req))) return send(403, 'Only for devices on your home network.', 'text/plain');
      if (!isLanHost(hostOf(req))) return send(403, 'Open this page with the Homebridge computer\'s address on your home network (its IP address or .local name).', 'text/plain');
      if (!web().on) return send(404, 'The web page is switched off on the plugin\'s settings page.', 'text/plain');
      const url = String(req.url || '/').replace(/\?.*$/, '');
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(200, html(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST' || !url.startsWith('/api/')) return send(404, { error: 'Not found' });
      // a request from this page only: its own header, and if the browser says where it came from, from this same address
      if (req.headers['x-home-energy'] !== '1') return send(403, { error: 'Not allowed' });
      const origin = req.headers.origin; if (origin) { let o; try { o = new URL(origin).host.toLowerCase(); } catch {} if (o !== String(req.headers.host || '').toLowerCase()) return send(403, { error: 'Not allowed' }); }
      // signed in before anything larger than a sign-in is read
      const ip = remoteOf(req), session = sessionOk(web(), cookieOf(req)), open = url === '/api/session' || url === '/api/login';
      if (!open && !session) { req.resume(); return send(401, { error: 'Sign in with your PIN.' }); }
      const body = await readBody(req, open ? 4096 : MAX_BODY);
      if (url === '/api/session') return send(200, { pinSet: !!web().pin, signedIn: !!session });
      if (url === '/api/login') {
        const f = fails.get(ip); if (f && f.until > Date.now()) return send(429, { error: `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.` });
        if (!web().pin) return send(403, { error: 'No PIN has been set yet. Set one on the plugin\'s settings page in the Homebridge UI: Settings → Web page.' });
        if (!pinOk(web(), String(body?.pin ?? ''))) {
          // wrong PINs count for 10 minutes from the first; after a lock-out has passed, counting starts again
          const fresh = !f || (f.until && f.until <= Date.now()) || Date.now() - f.first > LOCK_MS;
          const n = (fresh ? 0 : f.n) + 1; fails.set(ip, { n, first: fresh ? Date.now() : f.first, until: n >= FAILS ? Date.now() + LOCK_MS : 0 });
          if (fails.size > 1000) fails.clear();
          if (n >= FAILS) log.warn(`Web page: ${FAILS} wrong PINs from ${ip}; that address has to wait 10 minutes.`);
          return send(401, { error: 'That PIN isn\'t right.' });
        }
        fails.delete(ip);
        const raw = newSession(web()); onSaveNeeded();
        log.info(`Web page: a browser at ${ip} signed in.`);
        return send(200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_DAYS * 86400}` });
      }
      if (!session) return send(401, { error: 'Sign in with your PIN.' });
      if (Date.now() - session.seen > 3600e3) { session.seen = Date.now(); onSaveNeeded(); }
      if (url === '/api/logout') { endSession(web(), cookieOf(req)); onSaveNeeded(); return send(200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
      if (url === '/api/hb') {
        const fn = handlers[body?.route]; if (typeof fn !== 'function') return send(404, { error: 'Not found' });
        try { return send(200, { result: await fn(body.payload || {}) }); } catch (e) { return send(200, { error: String(e.message || e).slice(0, 600) }); }
      }
      return send(404, { error: 'Not found' });
    } catch (e) {
      // too large: answer, then close the connection rather than read the rest
      if (e.status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.socket.destroy()); }
      if (!res.headersSent) send(e.status || 400, { error: e.status === 413 ? 'Too large' : 'Bad request' });
    }
  });
  server.on('error', e => log.warn(e.code === 'EADDRINUSE' ? `The web page couldn't start: port ${port} is in use. Pick another "webPort" in the plugin's config, or switch the page off.` : `The web page couldn't start: ${e.message}`));
  server.listen(port, () => log.info(`Web page on port ${port} (home network only, PIN ${web().pin ? 'set' : 'not set yet'}).`));
  return { close: () => { try { server.close(); server.closeAllConnections?.(); } catch {} }, server };
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const onData = c => { size += c.length; if (size > max) { req.off('data', onData); req.pause(); reject(Object.assign(new Error('too large'), { status: 413 })); } else chunks.push(c); };
    req.on('data', onData);
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// The settings page is written for the Homebridge UI, which provides `homebridge` (requests, toasts) and Bootstrap's look.
// Here a small stand-in provides both, and a sign-in box when needed.
function wrap(pageHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shelly Home Energy</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f4f6; --fg: #1d1d1f; --card: #fff; --accent: #e5891a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f2; --card: #262628; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 1rem; }
  .top { display: flex; align-items: center; gap: 1rem; margin-bottom: .8rem; } .top h1 { font-size: 1.3rem; margin: 0; } .top button { margin-left: auto; }
  .he details.sec, .he .status { background: var(--card); }
  .form-control { box-sizing: border-box; width: 100%; padding: .4rem .55rem; border: 1px solid rgba(127,127,127,.4); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  .form-control-sm { padding: .2rem .4rem; font-size: .9em; } select.form-control { background: var(--card); }
  .btn { display: inline-block; padding: .4rem .8rem; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; cursor: pointer; line-height: 1.3; }
  .btn-sm { padding: .2rem .55rem; font-size: .88em; } .btn:disabled { opacity: .5; cursor: default; }
  .btn-primary { background: var(--accent); color: #fff; } .btn-danger { background: #c94450; color: #fff; } .btn-secondary { background: rgba(127,127,127,.35); }
  .btn-outline-primary { border-color: var(--accent); color: var(--accent); } .btn-outline-secondary { border-color: rgba(127,127,127,.6); } .btn-outline-danger { border-color: #c94450; color: #c94450; }
  .btn-link { color: var(--accent); text-decoration: underline; border: 0; }
  h6 { font-size: 1rem; }
  #he-toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; z-index: 10; }
  #he-toasts div { background: var(--card); border-left: 4px solid #1f9d63; padding: .6rem .9rem; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.25); max-width: 22rem; }
  #he-toasts div.e { border-left-color: #c94450; }
  #he-login { max-width: 22rem; margin: 15vh auto; background: var(--card); padding: 1.4rem; border-radius: 12px; display: none; }
  #he-login input { margin: .6rem 0; font-size: 1.2rem; letter-spacing: .2em; }
</style></head><body><div class="wrap">
<div class="top"><h1>Shelly Home Energy</h1><button class="btn btn-link btn-sm" id="he-signout" style="display:none">Sign out</button></div>
<div id="he-login"><b>Sign in</b><p id="he-login-msg" style="opacity:.75;font-size:.9em">Enter the PIN set on the plugin's settings page in the Homebridge UI.</p>
  <input class="form-control" id="he-pin" type="password" inputmode="numeric" autocomplete="current-password"><button class="btn btn-primary" id="he-go">Sign in</button><div id="he-login-err" style="color:#c94450;margin-top:.5rem"></div></div>
<div id="he-toasts"></div>
<script>
(() => {
  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Energy': '1' }, credentials: 'same-origin', body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch {} return { status: r.status, j }; };
  const toast = (m, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = m; document.getElementById('he-toasts').appendChild(d); setTimeout(() => d.remove(), 4500); };
  const login = msg => { document.getElementById('he-login').style.display = 'block'; const p = document.getElementById('he-page'); if (p) p.style.display = 'none'; if (msg) document.getElementById('he-login-msg').textContent = msg; setTimeout(() => document.getElementById('he-pin').focus(), 50); };
  window.homebridge = {
    web: true,
    async request(route, payload) {
      const { status, j } = await post('/api/hb', { route, payload });
      if (status === 401) { login(); throw new Error('Sign in with your PIN.'); }
      if (status !== 200 || !j) throw new Error(j?.error || 'The plugin didn\\'t answer (HTTP ' + status + ').');
      if (j.error) throw new Error(j.error);
      return j.result;
    },
    toast: { success: (m) => toast(m), error: (m) => toast(m, 'e') },
    showSpinner() { document.body.style.cursor = 'progress'; }, hideSpinner() { document.body.style.cursor = ''; },
  };
  const go = async () => { const { status, j } = await post('/api/login', { pin: document.getElementById('he-pin').value });
    if (status === 200) location.reload(); else document.getElementById('he-login-err').textContent = j?.error || 'Sign-in failed.'; };
  document.getElementById('he-go').onclick = go;
  document.getElementById('he-pin').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.getElementById('he-signout').onclick = async () => { await post('/api/logout'); location.reload(); };
  post('/api/session').then(({ j }) => { if (!j) return;
    if (!j.pinSet) login('No PIN has been set yet. Set one on the plugin\\'s settings page in the Homebridge UI (Settings → Web page), then reload.');
    else if (!j.signedIn) login(); else document.getElementById('he-signout').style.display = ''; });
})();
</script>
<div id="he-page">${pageHtml}</div>
</div></body></html>`;
}
