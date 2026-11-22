// The web page's sign-in, with requests handed straight to its server, so they can come from any home-network address.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, it } from 'vitest'

import { Engine } from './engine.js'
import { cleanWeb, hashPin, newSession, sessionOk } from './web-auth.js'
import { startWeb } from './web.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
let web

function setup(pin = '482615') {
  const engine = new Engine({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-webu-')), 's.json'),
    log: quiet,
  })
  if (pin) {
    engine.settings.web.pin = hashPin(pin)
  }
  web = startWeb({
    port: 0,
    engine,
    actions: {
      view: () => ({}),
    },
    storagePath: os.tmpdir(),
    log: quiet,
  })
  return engine
}

afterEach(() => {
  web?.close()
  web = null
})

/** One request to the page's server, from `ip`, as the page itself sends it. */
function request(ip, url, body, cookie) {
  const data = Buffer.from(JSON.stringify(body ?? {}))
  const req = Readable.from([data])
  Object.assign(req, {
    method: 'POST',
    url,
    headers: {
      'host': '192.168.1.2:8591',
      'x-home-energy': '1',
      'content-type': 'application/json',
      ...(cookie
        ? { cookie }
        : {}),
    },
    socket: {
      remoteAddress: ip,
      destroy() {},
    },
  })
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      status: 0,
      setHeader() {},
      on() {},
      writeHead(code) {
        this.status = code
        this.headersSent = true
      },
      end(s) {
        let json = null
        try {
          json = JSON.parse(s)
        } catch {}
        resolve({ status: this.status, json })
      },
    }
    web.server.emit('request', req, res)
  })
}
const login = (ip, pin) => request(ip, '/api/login', { pin })

it('a locked-out address stays locked out, however many other addresses try', async () => {
  setup()
  for (let i = 0; i < 5; i++) {
    assert.equal((await login('192.168.1.50', '000000')).status, 401)
  }
  assert.equal((await login('192.168.1.50', '482615')).status, 429)
  // the old code forgot every lock-out once 1,000 addresses had tried
  for (let i = 0; i < 1001; i++) {
    await login(`fe80::${i.toString(16)}`, '000000')
  }
  assert.equal((await login('192.168.1.50', '482615')).status, 429)
}, 60000)

it('wrong PINs from many addresses pause sign-in for the whole page', async () => {
  setup()
  // one wrong PIN each from 25 addresses: no address reaches its own limit of 5
  for (let i = 1; i <= 25; i++) {
    await login(`192.168.1.${i}`, '000000')
  }
  const r = await login('192.168.1.200', '482615')
  assert.equal(r.status, 429)
  assert.match(r.json.error, /Too many wrong PINs/)
})

it('a new PIN needs 6 or more characters', () => {
  assert.throws(() => hashPin('4826'), /6 to 32/)
  assert.throws(() => hashPin('48261'), /6 to 32/)
  assert.throws(() => hashPin('123456'), /easy to guess/)
  assert.ok(hashPin('482615').hash)
})

it('checks a PIN without stopping everything else while it works', async () => {
  setup()
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  await Promise.all(Array.from({ length: 4 }, (_, i) => login(`192.168.1.${i + 1}`, '000000')))
  clearInterval(timer)
  // scryptSync blocks: no timer could run while four PINs were checked
  assert.ok(ticks > 0, 'timers ran while PINs were checked')
})

it('a sign-in ends after 180 days, as its cookie says', () => {
  const w = cleanWeb({})
  const fresh = newSession(w)
  const old = newSession(w)
  const day = 86400e3
  w.tokens[0].at = Date.now() - 179 * day
  w.tokens[1].at = Date.now() - 181 * day
  assert.ok(sessionOk(w, fresh), '179 days old: still signed in')
  assert.equal(sessionOk(w, old), null, '181 days old: signed out')
  assert.equal(w.tokens.length, 1, 'and forgotten')
})

it('only the page\'s own routes are run, not names every JavaScript object has', async () => {
  const engine = setup()
  const cookie = `he_session=${newSession(engine.settings.web)}`
  for (const route of [
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ]) {
    const r = await request('192.168.1.9', '/api/hb', {
      route,
      payload: { x: 1 },
    }, cookie)
    assert.equal(r.status, 404, route)
  }
  assert.equal((await request('192.168.1.9', '/api/hb', {
    route: '/call',
    payload: { action: 'view' },
  }, cookie)).status, 200)
})
