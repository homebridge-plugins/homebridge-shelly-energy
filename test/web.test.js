// The plugin's own web page (lib/web.js), run with the real plugin on a stand-in Homebridge:
// the page is served, only to home-network host names; requests need the page's header and its own origin; no PIN = no sign-in;
// wrong PINs lock out; signed in, the page's actions work but never the PIN ones; nothing secret reaches the page or an export.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
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
  process.env.HE_MATTER_WORKER = path.join(HERE, 'fake-matter-worker.js')
  api = fakeApi({ storage: dir, configPath: cfg })
  log = fakeLog()
  plugin(api)
  void new api.Platform(log, block, api)
  api.emit('didFinishLaunching')
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'home-energy', 'control.json')); i++) await wait(100)
  await wait(300)
})

afterAll(() => {
  api.emit('shutdown')
})

it('the page is served to a home-network address, not to other host names', async () => {
  const r = await req('GET', '/')
  assert.equal(r.status, 200)
  assert.match(r.body, /Shelly Home Energy/)
  assert.match(r.body, /window\.homebridge/)
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

it('requests need the page\'s own header and origin; no PIN set means no sign-in', async () => {
  assert.equal((await req('POST', '/api/session', { body: {} })).status, 403)
  assert.equal((await api_('/api/session', {}, null, { Origin: 'http://attacker.example.com' })).status, 403)
  const s = await api_('/api/session', {})
  assert.deepEqual(s.json, { pinSet: false, signedIn: false })
  const l = await api_('/api/login', { pin: '1234' })
  assert.equal(l.status, 403)
  assert.match(l.json.error, /No PIN/)
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
  await assert.rejects(hb('webSetPin', { pin: '1111' }), /easy to guess/)
  await assert.rejects(hb('webSetPin', { pin: '12' }), /4 to 32/)
  await hb('webSetPin', { pin: '4826' })
  const l = await api_('/api/login', { pin: '4826' })
  assert.equal(l.status, 200)
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
  assert.deepEqual(Object.keys(w).sort(), ['on', 'pinSet', 'sessions'])
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

it('wrong PINs lock that address out; a new PIN signs every browser out', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await api_('/api/login', { pin: '0000x' })).status, 401)
  const locked = await api_('/api/login', { pin: '4826' })
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
  await hb('webSetPin', { pin: '7391' })
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
