// the Shelly EM poller and both Shelly device readers against stand-ins on this computer.

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import http from 'node:http'

import { it } from 'vitest'

import { startFakeEm, startFakeGen1, startFakeGen2, startFakeRpc, startFakeShelly } from '../test/fake-shelly.js'
import { hostList, isLanHost, lanHost, rejectedHosts } from './hosts.js'
import { getDevice } from './net.js'
import { gen1Devices, hkDevices, rpcDevices, ShellyDevices } from './shelly-devices.js'
import { EmPoller, parseChannels, parseGen1 } from './shelly-em.js'

const wait = ms => new Promise(r => setTimeout(r, ms))
const logs = []
const log = {
  info: m => logs.push(['info', m]),
  warn: m => logs.push(['warn', m]),
  error: m => logs.push(['error', m]),
  debug() {},
}

it('addresses: only the home network, and none written with leading zeros', () => {
  assert.deepEqual(
    hostList('192.168.1.50 10.0.0.2:8080 shelly.local 8.8.8.8 example.com http://172.16.0.4/x user@192.168.1.9'),
    [
      '192.168.1.50',
      '10.0.0.2:8080',
      'shelly.local',
      '172.16.0.4',
    ],
  )
  assert.deepEqual(rejectedHosts('192.168.1.50, 8.8.8.8, example.com'), ['8.8.8.8', 'example.com'])
  assert.equal(isLanHost('192.168.300.1'), false)
  assert.equal(isLanHost('fe80::1'), true)
  assert.equal(isLanHost('172.32.0.1'), false)
  // a leading 0 is octal to the network library: "010.0.0.1" would go to 8.0.0.1 on the internet. None get through.
  for (const h of [
    '010.0.0.1',
    '192.168.010.5',
    '10.0.0.01',
    '0127.0.0.1',
    '0xa.0.0.1',
    '10.1',
    '167772161',
  ]) {
    assert.equal(lanHost(h), '', h)
  }
})

it('reactive power: from apparent power on Gen2+ meters, from "reactive" on Gen1, none when not given', () => {
  const [c] = parseChannels({
    'em1:0': { act_power: 800, aprt_power: 1000 },
  })
  assert.equal(Math.round(c.q), 600)
  assert.equal(parseChannels({
    'em1:0': { act_power: 800 },
  })[0].q, null)
  const [t] = parseChannels({
    'em:0': { total_act_power: 300, total_aprt_power: 500 },
  })
  assert.equal(Math.round(t.q), 400)
  const g = parseGen1({
    emeters: [
      { power: 900, reactive: -250, is_valid: true },
    ],
  })
  assert.equal(g[0].q, 250)
})

it('parsing: EM clamps, HomeKit firmware relays, Gen2 switches and meters', () => {
  assert.equal(
    parseChannels({
      'em1:0': { act_power: 512 },
      'em1:1': { act_power: 3 },
      'sys': {},
    }).length,
    2,
  )
  const hk = hkDevices(
    {
      device_id: 'shelly1-x',
      model: 'Shelly1PM',
      components: [
        {
          id: 1,
          type: 0,
          name: 'Heater',
          svc_type: 0,
          state: true,
          apower: 801.26,
        },
        { id: 2, type: 5, name: 'In' },
      ],
    },
    '127.0.0.1',
  )
  assert.equal(hk.length, 1)
  assert.equal(hk[0].id, 'shk:shelly1-x:1')
  assert.equal(hk[0].values.Watts, 801.3)
  const g = rpcDevices(
    { id: 'p1', gen: 3, model: 'S3SW' },
    {
      'switch:0': { name: 'Pump' },
    },
    {
      'switch:0': { output: true, apower: 450 },
      'pm1:0': { apower: 12 },
      'input:0': { state: true },
    },
    'h',
  )
  assert.deepEqual(
    g.map(x => [x.id, x.name, x.on, x.values.Watts]),
    [
      ['shrpc:p1:0', 'Pump', true, 450],
      [
        'shrpc:p1:pm0',
        'S3SW 1',
        undefined,
        12,
      ],
    ],
  )
})

it(
  'reads a HomeKit-firmware Shelly and a Gen2 plug, recognising each by itself; a password is reported',
  async () => {
    const hk = startFakeShelly(18711, { name: 'Garage light' })
    const g2 = startFakeGen2(18712, { name: 'Dryer' })
    const locked = startFakeGen2(18713, { password: true })
    let changes = 0
    const s = new ShellyDevices({
      log,
      hosts: ['127.0.0.1:18711', '127.0.0.1:18712', '127.0.0.1:18713'],
      onChange: () => changes++,
    })
    await s.pollAll()
    const st = Object.fromEntries(s.status().map(x => [x.host, x]))
    assert.equal(st['127.0.0.1:18711'].kind, 'homekit')
    assert.equal(st['127.0.0.1:18712'].kind, 'rpc')
    assert.equal(st['127.0.0.1:18713'].ok, false)
    assert.match(st['127.0.0.1:18713'].msg, /password/)
    assert.deepEqual(
      s
        .list()
        .map(a => a.name)
        .sort(),
      ['Dryer', 'Garage light'],
    )
    g2.st.on[0] = true
    g2.st.w[0] = 2100
    hk.st.state = true
    await s.pollAll()
    const dryer = s.list().find(a => a.name === 'Dryer')
    assert.equal(dryer.on, true)
    assert.equal(dryer.values.Watts, 2100)
    assert.equal(s.list().find(a => a.name === 'Garage light').on, true)
    assert.ok(changes >= 2)
    hk.close()
    g2.close()
    locked.close()
  },
)

it('a Shelly that goes offline: reported, no stale state after a minute, back when it answers', async () => {
  const g2 = startFakeGen2(18714, { name: 'Pump' })
  const s = new ShellyDevices({
    log,
    hosts: ['127.0.0.1:18714'],
    live: false,
  }) // polling only (the live connection has its own tests)
  await s.pollAll()
  g2.st.on[0] = true
  await s.pollAll()
  assert.equal(s.list()[0].on, true)
  g2.st.down = true
  const d = s.devs.get('127.0.0.1:18714')
  await s.pollAll()
  assert.equal(s.status()[0].ok, false)
  assert.equal(s.list()[0].on, true, 'kept for a minute')
  d.seen = Date.now() - 61e3
  await s.pollAll()
  assert.equal(s.list()[0].on, undefined)
  assert.equal(s.list()[0].reachable, false)
  for (let i = 0; i < 4; i++) await s.pollAll()
  assert.ok(logs.some(([l, m]) => l === 'warn' && /127.0.0.1:18714/.test(m)))
  g2.st.down = false
  await s.pollAll()
  assert.equal(s.status()[0].ok, true)
  assert.equal(s.list()[0].on, true)
  assert.ok(logs.some(([l, m]) => l === 'info' && /connected again/.test(m)))
  g2.close()
})

it('the EM poller: samples, chosen clamp, offline and back, one warning', async () => {
  const em = startFakeEm(18715)
  const got = []
  const stats = []
  const whs = []
  const p = new EmPoller({
    log,
    onSample: (t, w, q, wh) => {
      got.push(w)
      whs.push(wh)
    },
    onStatus: s => stats.push(s),
    interval: 50,
    live: false,
    timing: {
      down: [100, 150],
    },
  }) // plain reads (the live connection has its own test)
  p.set('127.0.0.1:18715', 'em1:0')
  p.start()
  await wait(300)
  assert.ok(got.length >= 3 && got.every(w => w === 350))
  assert.equal(whs.at(-1), 123456.5) // the meter's own count comes with each reading
  assert.equal(p.status.ok, true)
  assert.equal(p.status.channels.length, 2)
  assert.match(p.status.msg, /CT clamp 1/)
  em.st.down = true
  const warnsBefore = logs.filter(([l]) => l === 'warn').length
  const triesBefore = em.st.tries
  await wait(600)
  assert.equal(p.status.ok, false)
  assert.equal(logs.filter(([l]) => l === 'warn').length - warnsBefore, 1)
  assert.ok(
    em.st.tries - triesBefore <= 6,
    `backs off while down (${em.st.tries - triesBefore} tries in 0.6 s, not 12)`,
  )
  em.st.down = false
  await wait(400)
  assert.equal(p.status.ok, true)
  p.set('127.0.0.1:18715', 'sum')
  em.st.w2 = 100
  await wait(300)
  assert.equal(got.at(-1), 450)
  assert.equal(whs.at(-1), 123466.5) // both clamps' counts
  p.stop()
  em.close()
})

it('the EM poller\'s live connection: changes pushed, a reading still passed on every second, no requests; quiet → asked; stuck → reads again', async () => {
  const em = startFakeEm(18716)
  const got = []
  const p = new EmPoller({
    log,
    onSample: (t, w) => got.push([t, w]),
    interval: 100,
    timing: {
      ask: 300,
      dead: 900,
      retry: [400],
    },
  })
  p.set('127.0.0.1:18716', 'em1:0')
  p.start()
  for (let i = 0; i < 40 && !/Live connection/.test(p.status.msg); i++) await wait(100)
  assert.match(p.status.msg, /^Live connection \(CT clamp 1\)/)
  const gets = em.st.gets
  em.st.w = 2350
  const t0 = Date.now()
  while (Date.now() - t0 < 1500 && got.at(-1)[1] !== 2350) await wait(20)
  assert.equal(got.at(-1)[1], 2350, 'the kettle shows up')
  const n = got.length
  await wait(1000)
  assert.ok(got.length - n >= 8, `still a reading every interval while nothing changes (${got.length - n})`)
  assert.equal(em.st.gets, gets, 'no HTTP requests while live')
  assert.ok(em.st.wsGets >= 2, 'quiet: asked over the live connection')
  // stuck: no answers at all on the live connection; the plain reads take over, and it comes back later
  em.st.mute = true
  for (let i = 0; i < 30 && !/Read every second/.test(p.status.msg); i++) await wait(100)
  assert.match(p.status.msg, /^Read every second/)
  assert.ok(em.st.gets > gets, 'reading by request again')
  em.st.mute = false
  for (const x of em.socks) x.destroy()
  for (let i = 0; i < 40 && !/Live connection/.test(p.status.msg); i++) await wait(100)
  assert.match(p.status.msg, /^Live connection/, 'reconnected')
  p.stop()
  em.close()
}, 20000)
it(
  'gen2+ parts: a cover, a dimmer, an RGBW strip, EM clamps and a 3-phase total, with the house clamp left out',
  () => {
    const st = {
      'cover:0': { state: 'opening', apower: 85.2 },
      'light:0': { output: true, apower: 40 },
      'rgbw:0': { output: false, apower: 0.4 },
      'em1:0': { act_power: 2500 },
      'em1:1': { act_power: 1800 },
      'em:0': { total_act_power: 3100, a_act_power: 1000 },
      'input:0': { state: false },
    }
    const isMain = (h, k) => k === 'em1:0'
    const d = rpcDevices(
      { id: 'dev9', gen: 3, app: 'Pro' },
      {
        'em1:1': { name: 'Hot water' },
      },
      st,
      'h',
      isMain,
    )
    assert.deepEqual(
      d.map(x => [
        x.id,
        x.name,
        x.type,
        x.on,
        x.values.Watts,
      ]),
      [
        [
          'shrpc:dev9:cover0',
          'Pro 1',
          'WindowCovering',
          undefined,
          85.2,
        ],
        [
          'shrpc:dev9:light0',
          'Pro 1',
          'Lightbulb',
          true,
          40,
        ],
        [
          'shrpc:dev9:rgbw0',
          'Pro 1',
          'Lightbulb',
          false,
          0.4,
        ],
        [
          'shrpc:dev9:em1-1',
          'Hot water',
          'PowerMeter',
          undefined,
          1800,
        ],
        [
          'shrpc:dev9:em-0',
          'Pro total',
          'PowerMeter',
          undefined,
          3100,
        ],
      ],
    )
    // ids of switches and meters are unchanged, so appliances tracked before keep their device
    assert.deepEqual(
      rpcDevices(
        { id: 'p', gen: 2 },
        {},
        {
          'switch:0': { output: true, apower: 1 },
          'pm1:0': { apower: 2 },
        },
        'h',
      ).map(x => x.id),
      ['shrpc:p:0', 'shrpc:p:pm0'],
    )
  },
)

it('gen1 parsing: 1PM, EM, 3EM, 2.5 in roller mode, Dimmer', () => {
  const g = (type, status, settings = {}) => gen1Devices({ type, mac: 'AABB' }, settings, status, 'h')
  assert.deepEqual(
    g(
      'SHSW-PM',
      {
        relays: [
          { ison: true },
        ],
        meters: [
          { power: 812.34, is_valid: true },
        ],
      },
      {
        relays: [
          { name: 'Heater' },
        ],
      },
    ).map(x => [x.id, x.name, x.on, x.values.Watts]),
    [
      [
        'shg1:aabb:relay0',
        'Heater',
        true,
        812.3,
      ],
    ],
  )
  assert.deepEqual(
    g('SHEM', {
      relays: [
        { ison: false },
      ],
      emeters: [
        { power: 500, is_valid: true },
        { power: 20, is_valid: false },
      ],
    }).map(x => [x.id, x.values.Watts]),
    [
      ['shg1:aabb:relay0', undefined],
      ['shg1:aabb:emeter0', 500],
    ],
  )
  assert.deepEqual(
    g('SHSW-25', {
      rollers: [
        { power: 120 },
      ],
      relays: [
        { ison: false },
        { ison: false },
      ],
      meters: [
        { power: 120, is_valid: true },
        { power: 0, is_valid: true },
      ],
    }).map(x => [x.id, x.type]),
    [
      ['shg1:aabb:roller0', 'WindowCovering'],
    ],
  )
  assert.deepEqual(
    g('SHDM-2', {
      lights: [
        { ison: true },
      ],
      meters: [
        { power: 35, is_valid: true },
      ],
    }).map(x => [x.id, x.type, x.values.Watts]),
    [
      ['shg1:aabb:light0', 'Lightbulb', 35],
    ],
  )
  assert.deepEqual(
    parseGen1({
      emeters: [
        { power: 1, is_valid: true },
        { power: 2, is_valid: true },
        { power: 3, is_valid: true },
      ],
    }).map(c => c.label),
    ['Phase A', 'Phase B', 'Phase C'],
  )
})

it(
  'reads Gen1 Shellys and a Gen3 with a cover and EM clamps over the network; a Gen1 with a login is reported',
  async () => {
    const pm = startFakeGen1(18721, { type: 'SHSW-PM' })
    const em = startFakeGen1(18722, { type: 'SHEM' })
    const locked = startFakeGen1(18723, { auth: true })
    const pro = startFakeRpc(18724, {
      status: () => ({
        'cover:0': { state: 'closing', apower: 90 },
        'em1:0': { act_power: 640 },
      }),
      config: {
        'cover:0': { name: 'Blinds' },
      },
    })
    const s = new ShellyDevices({
      log,
      hosts: [
        '127.0.0.1:18721',
        '127.0.0.1:18722',
        '127.0.0.1:18723',
        '127.0.0.1:18724',
      ],
      isMain: (h, k) => h === '127.0.0.1:18722' && k === 'emeter:0',
    })
    pm.st.on = true
    pm.st.w = 1500
    await s.pollAll()
    const st = Object.fromEntries(s.status().map(x => [x.host, x]))
    assert.equal(st['127.0.0.1:18721'].kind, 'gen1')
    assert.equal(st['127.0.0.1:18724'].kind, 'rpc')
    assert.match(st['127.0.0.1:18723'].msg, /password/)
    const by = Object.fromEntries(s.list().map(a => [a.name, a]))
    assert.equal(by.Heater.values.Watts, 1500)
    assert.equal(by.Heater.on, true)
    assert.equal(by['Hot water'].values.Watts, 20, 'second EM clamp offered')
    assert.ok(!s.list().some(a => a.id.endsWith('emeter0')), 'the house clamp is not')
    assert.equal(by.Blinds.values.Watts, 90)
    assert.ok(s.list().some(a => a.id.endsWith(':em1-0') && a.values.Watts === 640))
    pm.close()
    em.close()
    locked.close()
    pro.close()
  },
)

it('a Gen1 Shelly EM or 3EM as the whole-house meter (a 3EM adds its phases)', async () => {
  const em = startFakeGen1(18725, { type: 'SHEM' })
  const em3 = startFakeGen1(18726, { type: 'SHEM-3' })
  const got = []
  const p = new EmPoller({
    log,
    onSample: (t, w) => got.push(w),
    interval: 50,
  })
  p.set('127.0.0.1:18725', 'auto')
  p.start()
  await wait(300)
  assert.equal(got.at(-1), 350)
  assert.match(p.status.msg, /CT clamp 1/)
  assert.deepEqual(p.keys, ['emeter:0'])
  p.set('127.0.0.1:18726', 'auto')
  await wait(300)
  assert.equal(got.at(-1), 370)
  assert.match(p.status.msg, /all clamps/)
  p.stop()
  em.close()
  em3.close()
})
it('a device can\'t redirect the plugin elsewhere or flood it with a huge reply', async () => {
  let followed = false
  const target = http
    .createServer((q, r) => {
      followed = true
      r.end('{}')
    })
    .listen(18731)
  const odd = http
    .createServer((q, r) => {
      if (q.url === '/go') {
        r.writeHead(302, { Location: 'http://127.0.0.1:18731/' })
        return r.end()
      }
      if (q.url === '/huge') {
        r.writeHead(200, { 'Content-Type': 'application/json' })
        const chunk = Buffer.alloc(64 * 1024, 32)
        let k = 0
        const more = () => {
          while (k++ < 64) {
            if (!r.write(chunk)) {
              return r.once('drain', more)
            }
          }
          r.end()
        }
        return more()
      }
      r.end(JSON.stringify({ ok: 1 }))
    })
    .listen(18732)
  try {
    const go = await getDevice(fetch, '127.0.0.1:18732', 'go')
    assert.equal(go.ok, false)
    assert.equal(go.status, 302)
    assert.equal(followed, false, 'redirect not followed')
    await assert.rejects(getDevice(fetch, '127.0.0.1:18732', 'huge'), /far more than expected/)
    assert.deepEqual((await getDevice(fetch, '127.0.0.1:18732', 'fine')).json, { ok: 1 })
  } finally {
    target.close()
    odd.close()
  }
})

it('gen2+: a live connection pushes each change at once; no 3 s reading while it\'s up; steady loads still count as fresh', async () => {
  const g = startFakeGen2(18741, { name: 'Dryer' })
  let calls = 0
  const s = new ShellyDevices({
    log,
    hosts: ['127.0.0.1:18741'],
    onChange: () => calls++,
    timing: { fresh: 1000, poll: 300 },
  })
  try {
    s.start()
    for (let i = 0; i < 50 && !s.status()[0].live; i++) await wait(100)
    assert.equal(s.status()[0].live, true, 'live connection open')
    const gets = g.st.gets
    g.st.on[0] = true
    g.st.w[0] = 2100
    const t0 = Date.now()
    while (Date.now() - t0 < 2000 && s.list()[0]?.values.Watts !== 2100) await wait(20)
    assert.equal(s.list()[0].on, true)
    assert.equal(s.list()[0].values.Watts, 2100)
    assert.ok(Date.now() - t0 < 1000, `pushed in ${Date.now() - t0} ms, not on the next 3 s reading`)
    assert.ok(g.st.pushes >= 1)
    calls = 0
    await wait(3500)
    assert.equal(g.st.gets, gets, 'no HTTP readings while live')
    assert.ok(calls >= 2, `readings passed on while nothing changed (${calls})`)
  } finally {
    s.stop()
    g.close()
  }
}, 15000)

it('gen2+: if the live connection stops answering, the 3 s reading takes over; it reconnects later; old firmware just polls', async () => {
  const g = startFakeGen2(18742, { name: 'Pump' })
  const old = startFakeGen2(18743, { name: 'Old one', ws: false })
  const s = new ShellyDevices({
    log,
    hosts: ['127.0.0.1:18742', '127.0.0.1:18743'],
    onChange: () => {},
    timing: {
      check: 300,
      reply: 300,
      retry: [500],
      poll: 300,
    },
  })
  try {
    s.start()
    const st = h => s.status().find(x => x.host === h)
    for (let i = 0; i < 50 && !st('127.0.0.1:18742').live; i++) await wait(100)
    assert.equal(st('127.0.0.1:18742').live, true)
    await wait(1000)
    assert.equal(st('127.0.0.1:18743').live, false, 'no live connection on firmware without it')
    assert.ok(old.st.gets >= 2, 'it is read every few seconds instead')
    // the device stops answering on the live connection (but still answers HTTP): it's noticed and polling resumes
    g.st.down = false
    const before = g.st.gets
    for (const x of g.socks) x.sendText = () => {} // replies go nowhere
    for (let i = 0; i < 40 && st('127.0.0.1:18742').live; i++) await wait(100)
    assert.equal(st('127.0.0.1:18742').live, false, 'a dead live connection is dropped')
    for (let i = 0; i < 30 && g.st.gets === before; i++) await wait(100)
    assert.ok(g.st.gets > before, 'polling took over')
    assert.equal(st('127.0.0.1:18742').ok, true)
    for (const x of g.socks) x.destroy()
    for (let i = 0; i < 50 && !st('127.0.0.1:18742').live; i++) await wait(100)
    assert.equal(st('127.0.0.1:18742').live, true, 'reconnected')
  } finally {
    s.stop()
    g.close()
    old.close()
  }
}, 20000)
