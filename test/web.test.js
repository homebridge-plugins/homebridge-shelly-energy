// The plugin's own web page (lib/web.js), run with the real plugin on a stand-in Homebridge:
// its port opens only once a PIN is set; the page is served, only to home-network host names; requests need the page's header
// and its own origin;
// wrong PINs lock out; signed in, the page's actions work but never the PIN ones; nothing secret reaches the page or an export.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, it } from 'vitest'

import { callPlugin } from '../lib/control.js'
import plugin from '../lib/index.js'
import { fakeApi, fakeLog } from './fake-homebridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let api
let log
let cookie = null
const PORT = 18591
const wait = ms => new Promise(r => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-web-'))
const cfg = path.join(dir, 'config.json')
const block = {
  platform: 'ShellyHomeEnergy',
  name: 'Shelly Home Energy',
  webPort: PORT,
  _bridge: {
    username: '0E:00:00:00:00:03',
    port: 51997,
    matter: { port: 5543 },
  },
}
fs.writeFileSync(
  cfg,
  JSON.stringify({
    bridge: { name: 'T' },
    platforms: [block],
  }),
)
const hb = (a, args) => callPlugin(path.join(dir, 'home-energy'), a, args)
// a raw request, so the Host and Origin headers can be set
function req(method, url, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined
      ? null
      : JSON.stringify(body)
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: url,
        headers: {
          Host: `127.0.0.1:${PORT}`,
          ...(data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              }
            : {}),
          ...(cookie
            ? { Cookie: cookie }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let b = ''
        res.on('data', c => (b += c))
        res.on('end', () => {
          let j = null
          try {
            j = JSON.parse(b)
          } catch {}
          resolve({
            status: res.statusCode,
            body: b,
            json: j,
            headers: res.headers,
          })
        })
      },
    )
    r.on('error', reject)
    if (data) {
      r.write(data)
    }
    r.end()
  })
}
function api_(url, body, cookie, extra = {}) {
  return req('POST', url, {
    body,
    cookie,
    headers: { 'X-Home-Energy': '1', 'Origin': `http://127.0.0.1:${PORT}`, ...extra },
  })
}

beforeAll(async () => {
  api = fakeApi({ storage: dir, configPath: cfg })
  log = fakeLog()
  plugin(api)
  const platform = new api.Platform(log, block, api)
  platform.matterDevices.worker = path.join(HERE, 'fake-matter-worker.js')
  api.emit('didFinishLaunching')
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'home-energy', 'control.json')); i++) await wait(100)
  await wait(300)
})

afterAll(() => {
  api.emit('shutdown')
})

it('with no PIN set, the web page\'s port stays closed; setting one opens it', async () => {
  await assert.rejects(req('GET', '/'), /ECONNREFUSED/)
  await hb('webSetPin', { pin: '482615' })
  await wait(300)
  assert.equal((await req('GET', '/')).status, 200)
})

it('the page is served to a home-network address, not to other host names', async () => {
  const r = await req('GET', '/')
  assert.equal(r.status, 200)
  assert.match(r.body, /Shelly Home Energy/)
  assert.match(r.body, /<script src="web-shim.js"><\/script>/)
  assert.match(r.body, /<script src="app.js"><\/script>/)
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(r.headers['x-frame-options'], 'DENY')
  assert.equal(
    (
      await req('GET', '/', {
        headers: { Host: 'attacker.example.com' },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await req('GET', '/', {
        headers: { Host: `homebridge.local:${PORT}` },
      })
    ).status,
    200,
  )
})

it('requests need the page\'s own header and origin; not signed in means nothing but the sign-in', async () => {
  assert.equal((await req('POST', '/api/session', { body: {} })).status, 403)
  assert.equal((await api_('/api/session', {}, null, { Origin: 'http://attacker.example.com' })).status, 403)
  const s = await api_('/api/session', {})
  assert.deepEqual(s.json, { pinSet: true, signedIn: false })
  assert.equal(
    (
      await api_('/api/hb', {
        route: '/call',
        payload: { action: 'view' },
      })
    ).status,
    401,
  )
  // nothing large is read before sign-in: a big request is refused as not signed in, a big "sign-in" as too large
  const big = {
    route: '/upload/piece',
    payload: {
      data: 'x'.repeat(1024 * 1024),
    },
  }
  assert.equal((await api_('/api/hb', big)).status, 401)
  assert.equal(
    (
      await api_('/api/login', {
        pin: 'x'.repeat(10000),
      })
    ).status,
    413,
  )
})

it('a PIN set in the Homebridge UI; easy PINs refused; sign in; the page works', async () => {
  await assert.rejects(hb('webSetPin', { pin: '111111' }), /easy to guess/)
  await assert.rejects(hb('webSetPin', { pin: '12' }), /6 to 32/)
  await assert.rejects(hb('webSetPin', { pin: '4826' }), /6 to 32/, 'at least 6 characters')
  await assert.rejects(hb('webSetPin', { pin: '123456' }), /easy to guess/)
  await hb('webSetPin', { pin: '482615' })
  const l = await api_('/api/login', { pin: '482615' })
  assert.equal(l.status, 200)
  assert.match(l.headers['set-cookie'][0], /Max-Age=2592000/, 'signed in for 30 days')
  const sc = l.headers['set-cookie'][0]
  assert.match(sc, /HttpOnly/)
  assert.match(sc, /SameSite=Strict/)
  cookie = sc.split(';')[0]
  const v = await api_(
    '/api/hb',
    {
      route: '/call',
      payload: { action: 'view' },
    },
    cookie,
  )
  assert.equal(v.status, 200)
  assert.equal(v.json.result.ok, true)
  const w = v.json.result.result.settings.web
  assert.deepEqual(Object.keys(w).sort(), ['on', 'pinSet', 'readOnly', 'sessions'])
  assert.ok(!JSON.stringify(v.json).match(/"salt"|"hash"|"tokens"/), 'no PIN hash or sign-in keys sent to the page')
})

it('the web page can\'t change the PIN or the web settings', async () => {
  for (const action of ['webSetPin', 'webSet', 'webSignOutAll']) {
    const r = await api_(
      '/api/hb',
      {
        route: '/call',
        payload: {
          action,
          args: { pin: '9999', on: false },
        },
      },
      cookie,
    )
    assert.match(r.json.error, /Unknown action/, action)
  }
})

it('an export from the web page carries no PIN or sign-ins', async () => {
  const s = await api_('/api/hb', { route: '/export/start', payload: {} }, cookie)
  let text = ''
  for (let i = 0; i < s.json.result.n; i++) {
    text += (
      await api_(
        '/api/hb',
        {
          route: '/export/piece',
          payload: { id: s.json.result.id, i },
        },
        cookie,
      )
    ).json.result
  }
  const d = JSON.parse(text)
  assert.equal(d.settings.web, undefined)
  assert.ok(!/"salt"|"tokens"/.test(text))
})

it('view-only: the web page shows everything but can change nothing, and can\'t download a backup', async () => {
  await hb('webSet', { readOnly: true })
  const v = await api_(
    '/api/hb',
    {
      route: '/call',
      payload: { action: 'view' },
    },
    cookie,
  )
  assert.equal(v.json.result.ok, true)
  assert.equal(v.json.result.result.web.readOnly, true)
  assert.equal(
    (
      await api_(
        '/api/hb',
        {
          route: '/call',
          payload: {
            action: 'summary',
            args: { days: 7 },
          },
        },
        cookie,
      )
    ).json.result.ok,
    true,
  )
  for (const [action, args] of [
    [
      'setSettings',
      { threshold: 60 },
    ],
    [
      'roomAdd',
      { name: 'Shed' },
    ],
    [
      'forgetSig',
      { id: 'x' },
    ],
  ]) {
    const r = await api_(
      '/api/hb',
      {
        route: '/call',
        payload: { action, args },
      },
      cookie,
    )
    assert.match(JSON.stringify(r.json), /view-only/, action)
  }
  assert.match(
    JSON.stringify((await api_('/api/hb', { route: '/export/start', payload: {} }, cookie)).json),
    /view-only/,
    'no backup download',
  )
  await hb('webSet', { readOnly: false })
  assert.equal(
    (
      await api_(
        '/api/hb',
        {
          route: '/call',
          payload: {
            action: 'roomAdd',
            args: { name: 'Shed' },
          },
        },
        cookie,
      )
    ).json.result.ok,
    true,
    'changes again once it is switched back',
  )
})

it('the page\'s styles and scripts are served with it, and only those scripts may run', async () => {
  const r = await req('GET', '/style.css')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/css/)
  assert.match(r.body, /\.he /)
  const js = await req('GET', '/app.js')
  assert.equal(js.status, 200)
  assert.match(js.headers['content-type'], /javascript/)
  assert.match(js.body, /function renderHealth/)
  const sh = await req('GET', '/web-shim.js')
  assert.equal(sh.status, 200)
  assert.match(sh.body, /window\.homebridge = /)
  const pg = await req('GET', '/')
  assert.ok(!/<script>/.test(pg.body), 'no script written into the page')
  assert.match(pg.headers['content-security-policy'], /script-src 'self';/)
})

it('wrong PINs lock that address out; a new PIN signs every browser out', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await api_('/api/login', { pin: '0000x' })).status, 401)
  const locked = await api_('/api/login', { pin: '482615' })
  assert.equal(locked.status, 429)
  assert.match(locked.json.error, /Too many/)
  assert.equal(
    (
      await api_(
        '/api/hb',
        {
          route: '/call',
          payload: { action: 'view' },
        },
        cookie,
      )
    ).status,
    200,
    'already signed in still works',
  )
  await hb('webSetPin', { pin: '739164' })
  assert.equal(
    (
      await api_(
        '/api/hb',
        {
          route: '/call',
          payload: { action: 'view' },
        },
        cookie,
      )
    ).status,
    401,
  )
})

it('switched off in the Homebridge UI: the page stops answering', async () => {
  await hb('webSet', { on: false })
  await wait(200)
  await assert.rejects(req('GET', '/'))
  await hb('webSet', { on: true })
  await wait(300)
  assert.equal((await req('GET', '/')).status, 200)
})

it('logs no errors', () => {
  assert.deepEqual(log.lines.filter(([l]) => l === 'error'), [])
})
