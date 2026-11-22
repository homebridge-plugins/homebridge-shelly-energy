// the energy engine on made-up readings: step detection, naming, stages, runs,
// measured and estimated appliances, Other, costs, suggestions, saving and the memory caps.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

import { billPeriod, dayKey, Engine } from './engine.js'
import { guessAppliance } from './patterns.js'
import { cheapNow, cleanTariff, costOf, rateAt } from './tariff.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
function mk() {
  return new Engine({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-')), 'state.json'),
    log: quiet,
  })
}
let rnd = 7
const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 6 // ±3 W, repeatable
// feed the meter 1 s at a time: 300 W of background plus load(t); list(t) are the devices, polled every 3 s
function run(e, t0, secs, load, list) {
  for (let i = 0; i < secs; i++) {
    const t = t0 + i * 1000
    if (list && i % 3 === 0) {
      e.setSource('shelly', list(t), t)
    }
    e.processSample(t, 300 + load(t) + noise())
  }
  return t0 + secs * 1000
}
function relay(on) {
  return {
    id: 'shk:dev1:0',
    name: 'Garage heater',
    type: 'Switch',
    on,
    values: {},
    protocol: 'shelly',
  }
}
function plug(on, w) {
  return {
    id: 'shrpc:plug1:0',
    name: 'Washing machine',
    type: 'Outlet',
    on,
    values: { Watts: w },
    protocol: 'shelly',
  }
}

it('detects steps, names them, recognises the next run and counts its energy', () => {
  const e = mk()
  let t = Date.now() - 3 * 3600e3
  for (let k = 0; k < 3; k++) {
    t = run(e, t, 120, () => 0)
    t = run(e, t, 180, () => 2000)
  }
  t = run(e, t, 120, () => 0)
  assert.equal(e.events.length, 6)
  const pats = e.patterns()
  assert.equal(pats.length, 1)
  assert.equal(pats[0].n, 6)
  assert.ok(Math.abs(pats[0].mean - 2000) < 20)
  const s = e.nameCluster(pats[0].key, 'Kettle', 'kettle')
  assert.equal(s.runs, 3)
  assert.ok(Math.abs(s.watts - 2000) < 20)
  assert.equal(e.patterns().length, 0)
  t = run(e, t, 200, () => 2000)
  assert.ok(e.running[s.id])
  assert.ok(e.now.alloc.per[s.id] > 1900)
  t = run(e, t, 30, () => 0)
  assert.ok(!e.running[s.id])
  assert.equal(s.runs, 4)
  const today = e.energy[dayKey(Date.now())] || e.energy[dayKey(t - 1000)]
  assert.ok(Object.values(e.energy).reduce((a, d) => a + (d.apps[s.id] || 0), 0) > 0.3)
  assert.ok(today.total > 0 && today.h.length === 24)
})

it('a heating element switching on inside a run is a stage of that appliance, not another appliance', () => {
  const e = mk()
  let t = Date.now() - 3 * 3600e3
  const ids = []
  t = run(e, t, 60, () => 0)
  t = run(e, t, 120, () => 300)
  t = run(e, t, 120, () => 2300)
  t = run(e, t, 120, () => 300)
  t = run(e, t, 60, () => 0)
  ids.push(...e.events.map(x => x.id))
  const s = e.learn(ids, 'Dryer', 'dry_cleaning')
  assert.equal(s.stages.length, 1)
  assert.ok(Math.abs(s.stages[0].watts - 2000) < 30)
  assert.equal(s.runs, 1)
  assert.throws(() => e.learn([], 'x'), /Need a name/)
  // next run: the element switching on is recognised as the dryer's stage
  t = run(e, t, 120, () => 300)
  run(e, t, 60, () => 2300)
  assert.equal(e.events[0].sig, s.id)
  assert.equal(e.events[0].stageOn, true)
})

it('each finished run joins the appliance\'s recent runs (its usual length)', () => {
  const e = mk()
  let t = Date.now() - 10 * 3600e3
  for (let k = 0; k < 6; k++) {
    t = run(e, t, 60, () => 0)
    t = run(e, t, 120, () => 1000)
  }
  t = run(e, t, 60, () => 0)
  const s = e.learn(
    e.events.map(x => x.id),
    'Heater',
  )
  t = run(e, t, 600, () => 1000)
  t = run(e, t, 60, () => 0)
  assert.equal(s.recentRuns.length, 7)
  assert.ok(Math.abs(s.recentRuns.at(-1) - 600) < 10)
  assert.ok(!('anomalies' in e.toData()))
})

it('a device with its own watts, tracked: exact readings, its step credited, run and finish, standby', () => {
  const e = mk()
  let t = Date.now() - 9 * 60e3
  let w = 0
  const list = () => [
    plug(true, w),
  ]
  t = run(e, t, 30, () => w, list)
  e.setDevRoom('shrpc:plug1:0', 'Laundry')
  assert.equal(e.view().devices.find(d => d.id === 'shrpc:plug1:0').room, 'Laundry', 'a room before it is tracked')
  const s = e.track('shrpc:plug1:0')
  assert.equal(s.metered, true)
  assert.equal(s.exposed, false)
  assert.equal(s.room, 'Laundry', 'tracked: the appliance is in the room chosen for its device')
  assert.ok(!e.settings.devRooms['shrpc:plug1:0'])
  w = 500
  t = run(e, t, 120, () => w, list)
  assert.ok(e.running[s.id])
  assert.ok(Math.abs(e.now.alloc.per[s.id] - 500) < 1)
  assert.ok(e.events.some(x => x.sig === s.id && x.dir === 'on' && x.metered))
  assert.equal(e.patterns().length, 0, 'its own steps never need naming')
  w = 2
  run(e, t, 6 * 60, () => w, list)
  assert.ok(!e.running[s.id])
  assert.equal(s.runs, 1)
  assert.ok(s.standbyW > 0 && s.standbyW < 3)
  e.untrack(s.id)
  assert.equal(s.metered, false)
})

it(
  'watts learned from switching a relay with no power reading; a switch hidden by another change is skipped',
  () => {
    const e = mk()
    let t = Date.UTC(2026, 10, 10, 8)
    let on = false
    let other = false
    const list = () => [
      relay(on),
      {
        id: 'shk:dev2:0',
        name: 'Lamp',
        type: 'Lightbulb',
        on: other,
        values: {},
        protocol: 'shelly',
      },
    ]
    t = run(e, t, 60, () => 0, list)
    for (let k = 0; k < 4; k++) {
      on = true
      t = run(e, t, 120, () => 1500, list)
      on = false
      t = run(e, t, 120, () => 0, list)
    }
    const x = e.estSummary()['shk:dev1:0']
    assert.equal(x.n, 8)
    assert.ok(Math.abs(x.w - 1500) < 5, x.w)
    on = true
    other = true
    t = run(e, t, 60, () => 1560, list)
    assert.equal(e.estSummary()['shk:dev1:0'].n, 8)
    assert.equal(e.estSummary()['shk:dev1:0'].skip, 1)
  },
)

it('an estimated appliance takes its share; typed watts win; sensors excluded', () => {
  const e = mk()
  let t = Date.now() - 12 * 60e3
  let on = false
  let motion = false
  const pir = m => ({
    id: 'mhub:9:3',
    name: 'Hall motion',
    type: 'MotionSensor',
    on: m,
    values: {},
    protocol: 'matter',
  })
  const list = () => [
    relay(on),
    pir(motion),
  ]
  t = run(e, t, 30, () => 0, list)
  assert.throws(() => e.track('shk:dev1:0'), /No estimate/)
  assert.throws(() => e.track('mhub:9:3'), /sensor/)
  for (let k = 0; k < 3; k++) {
    on = true
    motion = true
    t = run(e, t, 90, () => 800, list)
    on = false
    motion = false
    t = run(e, t, 90, () => 0, list)
  }
  assert.equal(e.estSummary()['shk:dev1:0'].used, 6)
  assert.ok(!e.estSummary()['mhub:9:3'])
  const s = e.track('shk:dev1:0')
  assert.equal(s.estimated, true)
  on = true
  t = run(e, t, 30, () => 800, list)
  assert.ok(Math.abs(e.allocate(1100).per[s.id] - 800) < 5)
  assert.ok(e.running[s.id])
  e.setEstWatts(s.id, 750)
  assert.equal(e.estWatts(s), 750)
  e.setEstWatts(s.id, null)
  assert.ok(Math.abs(e.estWatts(s) - 800) < 5)
  on = false
  t = run(e, t, 15, () => 0, list)
  assert.ok(!e.running[s.id])
  assert.equal(e.allocate(300).per[s.id], undefined)
})

it('electricity plan: time-of-use rates, tax, cheap hours, costs per hour', () => {
  const T = cleanTariff({
    mode: 'tou',
    rate: 0.3,
    tax: 15,
    taxIncl: false,
    fixed: 2,
    periods: [
      {
        name: 'Night',
        from: 21,
        to: 7,
        rate: 0.15,
      },
      {
        name: 'Peak',
        from: 7,
        to: 9,
        rate: 0.4,
        days: 'weekdays',
      },
    ],
  })
  const wed = h => new Date(2026, 10, 18, h, 30)
  assert.equal(rateAt(T, wed(23)), 0.15)
  assert.equal(rateAt(T, wed(3)), 0.15)
  assert.equal(rateAt(T, wed(8)), 0.4)
  assert.equal(rateAt(T, new Date(2026, 10, 21, 8)), 0.3)
  assert.equal(cheapNow(T, wed(23)), true)
  assert.equal(cheapNow(T, wed(12)), false)
  const hours = Array.from({ length: 24 }).fill(0)
  hours[23] = 1
  hours[12] = 1
  assert.ok(Math.abs(costOf(T, '2026-11-18', 2, hours) - (0.15 + 0.3) * 1.15) < 1e-9)
  assert.equal(cheapNow(cleanTariff({ rate: 0.3 })), false)
  const e = mk()
  assert.throws(() => e.setSettings({ cheapTile: true }), /time-of-use/)
  e.setSettings({ tariff: T })
  e.setSettings({ cheapTile: true })
  assert.equal(e.settings.cheapTile, true)
  e.setSettings({
    tariff: { mode: 'single', rate: 0.3 },
  })
  assert.equal(e.settings.cheapTile, false)
})

it('summary: per appliance, Other, total and cost add up', () => {
  const e = mk()
  let t = Date.now() - 2 * 3600e3
  e.setSettings({
    tariff: { mode: 'single', rate: 0.5 },
  })
  for (let k = 0; k < 2; k++) {
    t = run(e, t, 120, () => 0)
    t = run(e, t, 300, () => 1000)
  }
  t = run(e, t, 60, () => 0)
  e.learn(
    e.events.map(x => x.id),
    'Heater',
  )
  const s = e.summary(2)
  const sum = s.rows.reduce((a, r) => a + r.kwh, 0) + s.other.kwh
  assert.ok(Math.abs(sum - s.total.kwh) < 0.01, `${sum} vs ${s.total.kwh}`)
  assert.ok(Math.abs(s.total.cost - s.total.kwh * 0.5) < 1e-6)
  assert.equal(s.rows[0].name, 'Heater')
})

it('suggestions: a fingerprint, a device switching at the same moments, and dismissing', () => {
  assert.equal(
    guessAppliance(2400, [
      { t: 0, dir: 'on' },
      { t: 120e3, dir: 'off' },
    ]).name,
    'Kettle',
  )
  const e = mk()
  let t = Date.now() - 3600e3
  let on = false
  const list = () => [
    {
      id: 'mhub:5:1',
      name: 'Bathroom fan',
      type: 'Switch',
      on,
      values: {},
      protocol: 'matter',
    },
  ]
  t = run(e, t, 30, () => 0, list)
  for (let k = 0; k < 3; k++) {
    on = true
    t = run(e, t, 90, () => 120, list)
    on = false
    t = run(e, t, 90, () => 0, list)
  }
  const p = e.patterns()[0]
  assert.equal(p.suggestion?.name, 'Bathroom fan')
  e.dismissSuggestion('Bathroom fan', p.mean)
  assert.notEqual(e.patterns()[0].suggestion?.name, 'Bathroom fan')
})

it('steps from before a device was tracked: suggested as its appliance, and "Yes" credits them to it', () => {
  const e = mk()
  let t = Date.now() - 3600e3
  let on = false
  const list = () => [
    relay(on),
  ]
  t = run(e, t, 30, () => 0, list)
  for (let k = 0; k < 3; k++) {
    on = true
    t = run(e, t, 90, () => 900, list)
    on = false
    t = run(e, t, 90, () => 0, list)
  }
  const s = e.track('shk:dev1:0')
  const p = e.patterns()[0]
  assert.equal(p.suggestion.name, 'Garage heater')
  assert.equal(p.suggestion.sig, s.id)
  e.nameCluster(p.key, p.suggestion.name)
  assert.equal(e.patterns().length, 0)
  assert.equal(s.metered, true)
  assert.ok(e.events.filter(x => x.sig === s.id).length >= 6)
})

it(
  'an appliance linked to a device whatever its name; usual runs start again; keep on steps',
  () => {
    const e = mk()
    const t = Date.now() - 9 * 60e3
    const w = 0
    const list = () => [
      plug(true, w),
    ]
    run(e, t, 30, () => w, list)
    const s = e.newSig('Spa pump', {
      watts: 900,
      recentRuns: [600, 600, 600, 600, 600],
      relink: true,
    })
    e.track('shrpc:plug1:0', null, s.id)
    assert.equal(s.devId, 'shrpc:plug1:0')
    assert.equal(s.name, 'Spa pump')
    assert.equal(e.sigs.length, 1, 'no second appliance')
    assert.equal(s.relink, undefined)
    assert.deepEqual(s.recentRuns, [])
    assert.throws(() => e.track('shrpc:plug1:0', null, s.id), /tracked already/)
    e.untrack(s.id)
    assert.deepEqual(s.recentRuns, [])
    const s2 = e.newSig('Pool heater', { relink: true })
    e.keepSteps(s2.id)
    assert.equal(s2.relink, undefined)
  },
)

// a measured appliance whose plug reports every 3 s: `w(t)` is its draw
function plugRun(e, t0, secs, w, id = 'shrpc:plug1:0', name = 'Washing machine') {
  for (let i = 0; i < secs; i++) {
    const t = t0 + i * 1000
    const x = w(i)
    if (i % 3 === 0) {
      e.setSource(
        'shelly',
        [
          {
            id,
            name,
            type: 'Outlet',
            on: true,
            values: { Watts: x },
            protocol: 'shelly',
          },
        ],
        t,
      )
    }
    e.processSample(t, 300 + x)
  }
  return t0 + secs * 1000
}
// a dishwasher's two programmes, as power phases [minutes, W], then 20 minutes off
const ECO = [
  [5, 80],
  [20, 2000],
  [85, 80],
  [10, 2000],
  [30, 30],
]
const QUICK = [
  [3, 80],
  [15, 2100],
  [22, 80],
]
const mins = P => P.reduce((a, [m]) => a + m, 0)
const OFF = 20
function phases(P, upTo = Infinity) {
  const out = []
  let left = upTo
  for (const [m, w] of P) {
    if (left <= 0) {
      break
    }
    out.push([
      Math.min(m, left),
      w,
    ])
    left -= m
  }
  return out
}
function feed(e, t, P) {
  for (const [m, w] of P) t = plugRun(e, t, m * 60, () => w, 'shrpc:dw1:0', 'Dishwasher')
  return t
}

it('learning a switch\'s watts in a jumpy house: a 2 kW heater still learned, a lamp skipped with the reason kept; switching together is "busy"', () => {
  const e = mk()
  let t = Date.now() - 3 * 3600e3
  let heat = false
  let lamp = false
  let other = false
  const jumpy = tt => 150 * Math.sin(tt / 7000) + 90 * Math.sin(tt / 2300) // a heat pump wandering by a couple of hundred watts
  const dev = (id, name, on) => ({
    id,
    name,
    type: 'Switch',
    on,
    values: {},
    protocol: 'shelly',
  })
  const list = () => [
    dev('shk:heat:1', 'Panel heater', heat),
    dev('shk:lamp:1', 'Lamp', lamp),
    dev('shk:other:1', 'Other relay', other),
  ]
  t = run(e, t, 60, jumpy, list)
  for (let k = 0; k < 4; k++) {
    heat = true
    t = run(e, t, 90, tt => jumpy(tt) + 2000, list)
    heat = false
    t = run(e, t, 90, jumpy, list)
    lamp = true
    t = run(e, t, 90, tt => jumpy(tt) + 30, list)
    lamp = false
    t = run(e, t, 90, jumpy, list)
  }
  const est = e.estSummary()
  assert.ok(
    Math.abs(est['shk:heat:1'].w - 2000) < 150,
    `heater learned despite the jumpy house: ${est['shk:heat:1'].w}`,
  )
  assert.equal(est['shk:lamp:1'].w, null, 'the lamp is lost in it')
  assert.ok(est['shk:lamp:1'].why.noisy >= 4, JSON.stringify(est['shk:lamp:1']))
  // two switching at the same moment: neither can be told apart
  lamp = true
  other = true
  t = run(e, t, 90, () => 30 + 500, list)
  assert.ok(e.estSummary()['shk:other:1'].why.busy >= 1)
  e.save()
  assert.ok(
    new Engine({ file: e.file, log: quiet }).estSummary()['shk:lamp:1'].why.noisy >= 4,
    'reasons kept after a restart',
  )
})

// a house with reactive power: each sample [watts, VAR]; a load adds its own watts and VAR (VAR = watts × tan(acos(pf)))
function runQ(e, t0, secs, load) {
  for (let i = 0; i < secs; i++) {
    const t = t0 + i * 1000
    const [p, q] = load(i)
    e.processSample(t, 300 + p + noise(), 80 + q)
  }
  return t0 + secs * 1000
}
const varOf = (w, pf) => w * Math.tan(Math.acos(pf))

it('power factor and start spikes: a heater and a pump of the same size are told apart, grouped apart and guessed right', () => {
  const e = mk()
  let t = Date.now() - 20 * 3600e3
  const heater = () => [
    800,
    varOf(800, 0.99),
  ]
  const pump = i => [
    820 + (i < 2
      ? 1500
      : 0),
    varOf(820, 0.78),
  ] // the pump jumps at start
  for (let k = 0; k < 4; k++) {
    t = runQ(e, t, 120, () => [0, 0])
    t = runQ(e, t, 300, heater)
    t = runQ(e, t, 120, () => [0, 0])
    t = runQ(e, t, 3600, pump)
  }
  t = runQ(e, t, 120, () => [0, 0])
  const on = e.events.filter(x => x.dir === 'on')
  assert.ok(on.length >= 8, `${on.length} steps`)
  const hs = on.filter(x => x.d < 1000 && x.pf >= 0.95)
  const ps = on.filter(x => x.pf != null && x.pf < 0.85)
  assert.ok(hs.length >= 3 && ps.length >= 3, JSON.stringify(on.map(x => [x.d, x.pf, x.spike])))
  assert.ok(
    ps.every(x => x.spike >= 1.5),
    'the pump\'s start spike',
  )
  assert.ok(
    hs.every(x => x.spike < 1.3),
    'none for the heater',
  )
  const P = e.patterns()
  const kinds = P.filter(p => Math.abs(p.mean - 810) < 100)
    .map(p => p.kind)
    .sort()
  assert.deepEqual(
    kinds,
    ['m', 'r'],
    `same size, two groups: ${JSON.stringify(P.map(p => [
      p.mean,
      p.n,
      p.kind,
      p.suggestion?.name,
    ]))}`,
  )
  // named the heater: a pump step of the same size isn't counted as the heater
  const hk = P.find(p => p.kind === 'r' && Math.abs(p.mean - 810) < 100)
  const s = e.nameCluster(hk.key, 'Panel heater', null)
  t = runQ(e, t, 120, () => [0, 0])
  t = runQ(e, t, 60, pump)
  assert.notEqual(e.events.find(x => x.dir === 'on' && x.t > t - 70e3)?.sig, s.id, 'a pump step is not the heater')
  t = runQ(e, t, 120, () => [0, 0])
  t = runQ(e, t, 60, heater)
  assert.equal(e.events.find(x => x.dir === 'on' && x.t > t - 70e3)?.sig, s.id, 'the heater is still recognised')
})

it('two known appliances switched on in the same second: one step split between them, each finishes on its own', () => {
  const e = mk()
  let t = Date.now() - 6 * 3600e3
  const go = (secs, w) => {
    for (let i = 0; i < secs; i++, t += 1000) e.processSample(t, 300 + w + noise())
  }
  for (let k = 0; k < 3; k++) {
    go(120, 0)
    go(200, 2000)
    go(120, 0)
    go(300, 600)
  } // a kettle and a pump, apart
  go(120, 0)
  const K = e.nameCluster(e.patterns().find(p => Math.abs(p.mean - 2000) < 200).key, 'Kettle', null)
  const Pm = e.nameCluster(e.patterns().find(p => Math.abs(p.mean - 600) < 100).key, 'Pump', null)
  go(120, 2600) // both at once
  const on = e.events.find(x => x.dir === 'on')
  assert.equal(Math.round(on.d / 100), 26)
  assert.ok([on.sig, on.also].includes(K.id) && [on.sig, on.also].includes(Pm.id), JSON.stringify(on))
  assert.ok(e.running[K.id] && e.running[Pm.id], 'both running')
  go(60, 600)
  assert.ok(!e.running[K.id] && e.running[Pm.id], 'the kettle finished, the pump still runs')
  go(60, 0)
  assert.ok(!e.running[Pm.id], 'then the pump')
})

it('an appliance and its own second stage switched on together (a spa: pump, then heater) is one run with the stage on', () => {
  const e = mk()
  let t = Date.now() - 6 * 3600e3
  const go = (secs, w) => {
    for (let i = 0; i < secs; i++, t += 1000) e.processSample(t, 300 + w + noise())
  }
  for (let k = 0; k < 3; k++) {
    go(120, 0)
    go(120, 500)
    go(400, 3200)
    go(60, 500)
    go(120, 0)
  }
  const Sp = e.nameCluster(e.patterns().find(p => Math.abs(p.mean - 500) < 80).key, 'Spa', null)
  e.learn(
    e.events.filter(x => Math.abs(Math.abs(x.d) - 2700) < 300).map(x => x.id),
    'Spa',
    null,
  )
  assert.equal(Sp.stages.length, 1, JSON.stringify(Sp.stages))
  assert.ok(Math.abs(Sp.stages[0].watts - 2700) < 150)
  go(120, 0)
  go(200, 3200)
  const on = e.events.find(x => x.dir === 'on')
  assert.equal(on.sig, Sp.id)
  assert.equal(on.withStage, Sp.stages[0].id)
  assert.deepEqual(e.activeStages[Sp.id], [Sp.stages[0].id])
  go(60, 500)
  assert.ok(e.running[Sp.id], 'heater off, pump on')
  go(60, 0)
  assert.ok(!e.running[Sp.id], 'all off')
})

it('a variable load (a heat pump) is followed as it turns itself up and down, and finishes when it falls to nothing', () => {
  const e = mk()
  let t = Date.now() - 8 * 3600e3
  const go = (secs, w) => {
    for (let i = 0; i < secs; i++, t += 1000) e.processSample(t, 300 + w + noise())
  }
  const hp = () => {
    go(600, 1200)
    go(600, 1900)
    go(600, 800)
    go(300, 1400)
  } // starts at 1.2 kW, ramps, then off from 1.4 kW
  for (let k = 0; k < 4; k++) {
    go(300, 0)
    hp()
  }
  go(300, 0)
  const g = e.patterns().find(p => Math.abs(p.mean - 1200) < 150)
  assert.ok(g, JSON.stringify(e.patterns().map(p => [p.mean, p.n])))
  const H = e.nameCluster(g.key, 'Heat pump', null)
  assert.equal(H.variable, true, 'a heat pump starts as a variable load')
  go(300, 0)
  const kwh0 = H.kwh
  go(600, 1200)
  assert.ok(e.running[H.id])
  go(600, 1900)
  assert.ok(e.running[H.id], 'still running after turning up')
  assert.ok(
    Math.abs(e.allocate(300 + 1900).per[H.id] - 1900) < 60,
    `its share follows the house: ${e.allocate(2200).per[H.id]}`,
  )
  go(600, 800)
  assert.ok(e.running[H.id], 'still running after turning down')
  go(100, 0)
  assert.ok(!e.running[H.id], 'finished when it fell to nothing')
  const want = ((1200 + 1900 + 800) * 600) / 3.6e6 // kWh
  assert.ok(
    Math.abs(H.kwh - kwh0 - want) < want * 0.06,
    `${(H.kwh - kwh0).toFixed(3)} kWh, expected about ${want.toFixed(3)}`,
  )
  // an unknown kettle used while it runs: not taken as the heat pump turning up, so it's found and can be named
  go(300, 0)
  go(600, 1200)
  for (let k = 0; k < 3; k++) {
    go(180, 1200 + 2000)
    go(300, 1200)
  }
  assert.ok(e.running[H.id], 'the heat pump still runs')
  const kettle = e.patterns().find(p => Math.abs(p.mean - 2000) < 200)
  assert.ok(
    kettle && kettle.n >= 6,
    `the kettle is in Found: ${JSON.stringify(e.patterns().map(p => [p.mean, p.n]))}`,
  )
  assert.ok(
    !e.events.some(x => x.vary && Math.abs(Math.abs(x.d) - 2000) < 200),
    'none of its steps taken as the heat pump varying',
  )
  const Kt = e.nameCluster(kettle.key, 'Kettle', null)
  go(180, 1200 + 2000)
  assert.ok(e.running[Kt.id], 'named: recognised next time, during a heat pump run')
  go(60, 1200)
  go(100, 0)
  assert.ok(!e.running[H.id] && !e.running[Kt.id])
})

it('a fixed appliance whose runs keep ending without a matching step is suggested as varying', () => {
  const e = mk()
  let t = Date.now() - 8 * 3600e3
  const go = (secs, w) => {
    for (let i = 0; i < secs; i++, t += 1000) e.processSample(t, 300 + w + noise())
  }
  for (let k = 0; k < 3; k++) {
    go(300, 0)
    go(400, 1500)
    go(300, 0)
  }
  const C = e.nameCluster(e.patterns().find(p => Math.abs(p.mean - 1500) < 150).key, 'Charger', null)
  assert.ok(!C.variable)
  for (let k = 0; k < 4; k++) {
    go(300, 0)
    go(400, 1500)
    for (let w = 1500; w > 0; w -= 40) go(10, w)
    go(200, 0)
  } // tapers off
  assert.ok((C.oddEnds || 0) >= 3, `odd ends ${C.oddEnds}, runs ${C.runs}`)
})

it('habits break near ties: the appliance that usually starts at this hour, and the one whose usual run length fits', () => {
  const e = mk()
  const A = e.newSig('Morning heater', { watts: 1000, count: 10 })
  const B = e.newSig('Evening heater', { watts: 1080, count: 10 })
  const at = (h) => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    d.setHours(h, 0, 0, 0)
    return d.getTime()
  }
  for (let i = 0; i < 8; i++) {
    e.noteStart(A, at(7))
    e.noteStart(B, at(19))
  }
  assert.equal(
    e.matchSig(1035, false, {}, at(19)),
    B,
    'a 1035 W switch-on at 7 pm: the evening one, though the other is closer in size',
  )
  assert.equal(e.matchSig(1035, false, {}, at(7)), A, 'at 7 am: the morning one')
  assert.equal(e.matchSig(1035, false, {}, at(13)), A, 'at an hour neither uses: the closer in size')
  // both running: a switch-off goes to the one that has run about as long as it usually does
  A.recentRuns = [300, 320, 280, 310]
  B.recentRuns = [3600, 3500, 3700]
  const t0 = at(12)
  e.running[A.id] = t0
  e.running[B.id] = t0
  assert.equal(e.matchSig(1050, true, {}, t0 + 310e3), A, 'after 5 minutes: the short one')
  e.running[A.id] = e.running[B.id] = t0 - 3300e3
  assert.equal(
    e.matchSig(1030, true, {}, t0 + 300e3),
    B,
    'both started an hour ago: the one that usually runs an hour, though the other is closer in size',
  )
})

it('confidence: unsure with few runs or a look-alike, good once steady, told apart by power factor counts', () => {
  const e = mk()
  let t = Date.now() - 8 * 3600e3
  const go = (secs, w) => {
    for (let i = 0; i < secs; i++, t += 1000) e.processSample(t, 300 + w + noise())
  }
  for (let k = 0; k < 2; k++) {
    go(120, 0)
    go(200, 2000)
  }
  go(120, 0)
  const K = e.nameCluster(e.patterns()[0].key, 'Kettle', null)
  assert.equal(e.confidence(K).level, 'unsure')
  assert.match(e.confidence(K).why, /2 runs/)
  for (let k = 0; k < 3; k++) {
    go(120, 0)
    go(200, 2000)
  }
  go(120, 0)
  assert.equal(e.confidence(K).level, 'good', e.confidence(K).why)
  e.newSig('Jug', { watts: 2050, count: 5, runs: 5 })
  assert.equal(e.confidence(K).level, 'unsure')
  assert.match(e.confidence(K).why, /"Jug"/)
  const D = e.newSig('Dryer', { metered: true, devId: 'x' })
  assert.equal(e.confidence(D).level, 'exact')
  assert.ok(e.view().sigs.find(x => x.id === K.id).sure.level === 'unsure')
})

it('names are unique per room: "Downlights" in two rooms; naming and renaming find the right one', () => {
  const e = mk()
  const A = e.newSig('Downlights', { room: 'Dining Room', watts: 60, count: 3 })
  const B = e.newSig('Entrance Downlights', { room: 'Entrance Hall', watts: 90, count: 3 })
  e.editSig(B.id, { name: 'Downlights' })
  assert.equal(B.name, 'Downlights', 'the same name in another room is fine')
  assert.throws(
    () => e.editSig(B.id, { room: 'Dining Room' }),
    /already an appliance called "Downlights" in Dining Room/,
  )
  const C = e.newSig('Lamp', { room: 'Dining Room' })
  assert.throws(
    () => e.editSig(C.id, { name: 'downlights' }),
    /in Dining Room/,
    'the same name in the same room is refused',
  )
  assert.equal(e.label(A), 'Downlights (Dining Room)')
  assert.equal(e.label(C), 'Lamp')
  // naming steps: by name and room; with no room and two of that name, a new one; a suggestion's own appliance by id
  let t = Date.now() - 3600e3
  const ev = (d) => {
    const x = {
      id: `e${Math.random()}`,
      t: (t += 60e3),
      d,
      dir: d > 0
        ? 'on'
        : 'off',
      sig: null,
    }
    e.events.unshift(x)
    return x.id
  }
  assert.equal(e.learn([
    ev(90),
    ev(-90),
  ], 'Downlights', null, { room: 'Entrance Hall' }), B)
  assert.equal(e.learn([
    ev(60),
    ev(-60),
  ], 'Downlights', null, { sigId: A.id }), A)
  const D = e.learn([
    ev(75),
    ev(-75),
  ], 'Downlights', null, { room: '' })
  assert.ok(D !== A && D !== B && D.room === '', 'no room given, two of that name: a new one with no room')
})

it('last 7 days by hour: the house\'s kWh per hour, oldest day first, hours still to come empty', () => {
  const e = mk()
  const now = new Date()
  now.setHours(10, 30, 0, 0)
  const day = (n) => {
    const d = new Date(now)
    d.setHours(12)
    d.setDate(d.getDate() - n)
    return d.getTime()
  }
  let t = day(1) - 3600e3
  for (let i = 0; i < 120; i++, t += 10e3) e.processSample(t, 1800) // yesterday 11:00, 20 minutes at 1.8 kW
  t = now.getTime() - 600e3
  for (let i = 0; i < 30; i++, t += 10e3) e.processSample(t, 500) // today, before 10:30
  const W = e.weekHours(now.getTime())
  assert.equal(W.length, 7)
  assert.ok(W[6].h[10] > 0, 'this hour so far')
  assert.equal(W[6].h[11], null, 'later today: nothing yet')
  assert.ok(Math.abs(W[5].h[11] - 0.6) < 0.02, `yesterday 11:00: ${W[5].h[11]} kWh`)
  assert.equal(W[0].h, null, 'a day with no readings')
  assert.ok(Array.isArray(e.view().week))
  assert.equal(W[6].p, null, 'no plan: no prices')
  e.setSettings({
    tariff: {
      mode: 'tou',
      rate: 0.265,
      periods: [
        {
          name: 'Night',
          from: 21,
          to: 7,
          days: 'all',
          rate: 0.1795,
        },
      ],
    },
  })
  const P = e.weekHours(now.getTime())[6].p
  assert.equal(P[3], 0.1795, 'night')
  assert.equal(P[12], 0.265, 'day')
  assert.equal(P[21], 0.1795, 'night from 21:00')
})

it('billing period: a bill day moves the month figure, its forecast and the budget to the bill\'s own dates', () => {
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()
  const ymd = t => [
    t.getFullYear(),
    t.getMonth() + 1,
    t.getDate(),
  ]
  let B = billPeriod(at(2026, 11, 19), 15)
  assert.deepEqual([
    ymd(B.start),
    ymd(B.end),
    B.days,
  ], [
    [2026, 11, 15],
    [2026, 12, 15],
    30,
  ])
  B = billPeriod(at(2026, 11, 10), 15)
  assert.deepEqual(
    [
      ymd(B.start),
      ymd(B.end),
    ],
    [
      [2026, 10, 15],
      [2026, 11, 15],
    ],
    'before the bill day: last month\'s bill',
  )
  B = billPeriod(at(2027, 1, 5), 15)
  assert.deepEqual(ymd(B.start), [2026, 12, 15], 'across the new year')
  B = billPeriod(at(2026, 11, 19), 1)
  assert.deepEqual([
    ymd(B.start),
    B.days,
  ], [
    [2026, 11, 1],
    30,
  ], 'day 1: the calendar month')
  const e = mk()
  e.setSettings({
    billDay: 15,
    tariff: { mode: 'single', rate: 0.3, fixed: 1 },
  })
  for (const [dd, kwh] of [
    [14, 50],
    [15, 10],
    [16, 10],
  ]) {
    e.energy[`2026-11-${dd}`] = { total: kwh, apps: {}, other: 0 }
  }
  const M = e.monthStatus(at(2026, 11, 16, 18))
  assert.equal(M.from, '2026-11-15')
  assert.equal(M.to, '2026-12-14')
  assert.equal(M.dom, 2)
  assert.equal(M.dim, 30)
  assert.equal(M.kwh, 20, 'the 14th was the last bill')
  assert.ok(Math.abs(M.cost - (20 * 0.3 + 2)) < 1e-6, String(M.cost))
  e.setSettings({ billDay: 40 })
  assert.equal(e.settings.billDay, 28, 'at most 28, so every month has the day')
})

it('rooms: put in order, renamed (onto another: they become one), removed (its appliances have no room)', () => {
  const e = mk()
  const A = e.newSig('Lamp', { room: 'Lounge' })
  const B = e.newSig('Kettle', { room: 'Kitchen' })
  const C = e.newSig('Lamp 2', { room: 'Den' })
  for (const r of ['Lounge', 'Kitchen', 'Den']) e.noteRoom(r)
  e.setDevRoom('dev1', 'Den')
  e.setRoomOrder(['Kitchen', 'Den'])
  assert.deepEqual(e.settings.rooms, ['Kitchen', 'Den', 'Lounge'])
  assert.equal(e.settings.roomsOrdered, true)
  e.renameRoom('Den', 'Study')
  assert.equal(C.room, 'Study')
  assert.equal(e.settings.devRooms.dev1, 'Study')
  assert.deepEqual(e.settings.rooms, ['Kitchen', 'Study', 'Lounge'])
  e.renameRoom('Study', 'Lounge')
  assert.equal(C.room, 'Lounge')
  assert.deepEqual(e.settings.rooms, ['Kitchen', 'Lounge'], 'onto another: one room')
  e.newSig('Lamp', { room: 'Kitchen' })
  assert.throws(() => e.renameRoom('Kitchen', 'Lounge'), /already has an appliance called "Lamp"/)
  e.removeRoom('Lounge')
  assert.equal(A.room, '')
  assert.equal(C.room, '')
  assert.deepEqual(e.settings.rooms, ['Kitchen'])
  assert.equal(e.settings.devRooms.dev1, undefined)
  assert.equal(B.room, 'Kitchen')
})

it('a step that only happens while an appliance runs is suggested as part of it, and joins as a stage', () => {
  const e = mk()
  let t = Date.now() - 12 * 3600e3
  const ev = (d, dir) => {
    const x = {
      id: `ev${Math.random().toString(36).slice(2, 8)}`,
      t,
      d,
      dir,
      sig: null,
    }
    e.events.unshift(x)
    return x.id
  }
  const pump = []
  for (let k = 0; k < 4; k++) {
    pump.push(ev(495, 'on'))
    t += 300e3
    ev(2710, 'on')
    t += 1200e3
    ev(-2710, 'off')
    t += 300e3
    pump.push(ev(-495, 'off'))
    t += 3600e3
  }
  // something else that runs on its own, at other times: not suggested as part of the spa
  for (let k = 0; k < 3; k++) {
    ev(1900, 'on')
    t += 600e3
    ev(-1900, 'off')
    t += 3600e3
  }
  const spa = e.learn(pump, 'Spa Pool')
  const P = e.patterns()
  const heater = P.find(p => Math.abs(p.mean - 2700) < 100 && p.suggestion?.part)
  assert.ok(heater, JSON.stringify(P.map(p => [p.mean, p.n, p.suggestion])))
  assert.equal(heater.suggestion.name, 'Spa Pool')
  assert.match(heater.suggestion.why, /only while "Spa Pool" is running \(4 of/)
  assert.ok(
    !P.some(p => Math.abs(p.mean - 1900) < 100 && p.suggestion?.part),
    'a load that runs on its own is not part of it',
  )
  e.nameCluster(heater.key, heater.suggestion.name, null)
  assert.equal(spa.runs, 4, 'still four runs')
  assert.equal(spa.stages.length, 1)
})

it('two appliances made one: a spa heater named separately joins its pump as a stage; runs, energy and totals move across', () => {
  const e = mk()
  let t = Date.now() - 6 * 3600e3
  const ev = (d, dir) => {
    const x = {
      id: `ev${Math.random().toString(36).slice(2, 8)}`,
      t,
      d,
      dir,
      sig: null,
    }
    e.events.unshift(x)
    return x.id
  }
  const pump = []
  const heat = []
  for (let k = 0; k < 3; k++) {
    pump.push(ev(495, 'on'))
    t += 300e3
    heat.push(ev(2710, 'on'))
    t += 1200e3
    heat.push(ev(-2710, 'off'))
    t += 300e3
    pump.push(ev(-495, 'off'))
    t += 3600e3
  }
  const a = e.learn(pump, 'Spa Pool')
  const b = e.learn(heat, 'Spa heater')
  let day = Object.keys(e.energy)[0]
  if (!day) {
    day = '2026-01-01'
    e.energy[day] = { total: 5, apps: {}, other: 0 }
  }
  e.energy[day].apps[a.id] = 1
  e.energy[day].apps[b.id] = 2
  a.kwh = 10
  b.kwh = 20
  assert.equal(a.runs, 3)
  assert.equal(b.runs, 3)
  assert.throws(() => e.editSig(b.id, { name: 'spa pool' }), /already an appliance called/)
  e.mergeSig(b.id, a.id)
  assert.equal(e.sigs.length, 1)
  assert.equal(a.runs, 3, 'still three runs: the heater is part of each')
  assert.equal(a.stages.length, 1)
  assert.ok(Math.abs(a.stages[0].watts - 2710) < 1)
  assert.equal(e.events.filter(x => x.sig === a.id).length, 12)
  assert.equal(e.energy[day].apps[a.id], 3)
  assert.equal(e.energy[day].apps[b.id], undefined)
  assert.equal(a.kwh, 30)
  const p = e.newSig('Plug thing', { metered: true, devId: 'shrpc:p:0' })
  assert.throws(() => e.mergeSig(p.id, a.id), /own device/)
})

it('making two appliances one keeps the steps on the one chosen, when another room has one of the same name', () => {
  const e = mk()
  const t0 = Date.now() - 3 * 3600e3
  const ev = (t, d, sig, extra = {}) => e.events.unshift({
    id: `ev${Math.random().toString(36).slice(2, 8)}`,
    t,
    d,
    dir: d > 0
      ? 'on'
      : 'off',
    sig,
    ...extra,
  })
  const pumpSpa = e.newSig('Pump', { room: 'Spa', watts: 500 })
  const pumpPool = e.newSig('Pump', { room: 'Pool', watts: 800 })
  const heater = e.newSig('Heater', { room: 'Spa', watts: 2000 })
  ev(t0 - 60e3, 500, pumpSpa.id)
  ev(t0, 2000, heater.id)
  ev(t0 + 600e3, -2000, heater.id, { counted: true })
  ev(t0 + 1200e3, -500, pumpSpa.id, { counted: true })
  e.mergeSig(heater.id, pumpSpa.id)
  assert.deepEqual(e.sigs.map(s => s.id), [pumpSpa.id, pumpPool.id], 'no third "Pump"')
  assert.equal(e.events.filter(x => x.sig === pumpSpa.id).length, 4)
  assert.equal(pumpSpa.runs, 1)
  assert.equal(pumpSpa.stages.length, 1, 'the heater is a stage of the Spa pump')
})

it('this month so far and its forecast, with a budget; last week\'s summary for the comparison', () => {
  const e = mk()
  e.setSettings({
    tariff: { mode: 'single', rate: 0.3, fixed: 2 },
  })
  const now = new Date(2026, 10, 19, 12, 0).getTime() // 19 November, midday (30 days)
  for (let i = 0; i < 40; i++) {
    e.energy[dayKey(now - i * 86400e3)] = {
      total: 10,
      apps: {},
      other: 10,
      peak: 0,
      peakT: 0,
    }
  }
  const M = e.monthStatus(now)
  assert.equal(M.dom, 19)
  assert.equal(M.dim, 30)
  assert.equal(M.days, 19)
  assert.equal(M.kwh, 190)
  assert.ok(Math.abs(M.cost - 19 * (3 + 2)) < 1e-6, `so far ${M.cost}`)
  // so far $95 (today's figure here is already a whole day); to come: 11.5 days of $3 energy (the rest of today and 11 more
  // days) and 11 more daily charges of $2
  assert.ok(Math.abs(M.forecastCost - (95 + 11.5 * 3 + 11 * 2)) < 0.01, `forecast ${M.forecastCost}`)
  assert.equal(M.over, false)
  e.setSettings({ budget: 120, budgetTile: true })
  assert.equal(e.monthStatus(now + 1).over, true)
  assert.equal(e.settings.budgetTile, true)
  assert.throws(() => e.setSettings({ budget: -5 }), /budget/)
  e.setSettings({ budget: 0 })
  assert.equal(e.settings.budgetTile, false, 'no budget, no tile')
  // the 7 days before last week
  e.energy[dayKey(now - 8 * 86400e3)].total = 30
  assert.equal(e.summary(7, now - 7 * 86400e3).total.kwh, 90)
  assert.equal(e.summary(7, now).total.kwh, 70)
})

it('the power graph on Today: 5-minute steps from midnight, nothing before the first reading, the minute in progress, the peak', () => {
  const e = mk()
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const mid = d.getTime()
  let t = mid + 3600e3 // 01:00: 500 W for an hour, then 2 kW for an hour and a half
  for (let i = 0; i < 3600; i++, t += 1000) e.processSample(t, 500)
  for (let i = 0; i < 5430; i++, t += 1000) e.processSample(t, 2000)
  const c = e.curve(t - 1000)
  assert.equal(c.start, mid)
  assert.equal(c.step, 300e3)
  assert.equal(c.today.length, Math.floor((t - 1000 - mid) / 300e3) + 1)
  assert.equal(c.today[5], null, 'nothing before the first reading')
  assert.equal(c.today[13], 500)
  assert.equal(c.today[30], 2000)
  assert.equal(c.today.at(-1), 2000, 'the step in progress is there')
  assert.equal(c.peak.w, 2000)
  assert.equal(c.yesterday, null)
  assert.ok(JSON.stringify(e.view().curve).length < 8000, 'small enough to send every few seconds')
})

it('combined devices: two lamps as one appliance (watts added, on while either is on), switch-only and mixed, and taking one out', () => {
  const e = mk()
  let t = Date.now() - 3600e3
  const src = ls =>
    e.setSource(
      'shelly',
      ls.map(([id, name, w, on]) => ({
        id,
        name,
        type: 'Outlet',
        on,
        values: w == null
          ? {}
          : { Watts: w },
        protocol: 'shelly',
      })),
      t,
    )
  // two measuring plugs
  src([
    ['shrpc:a:0', 'Lamp A', 0, false],
    ['shrpc:b:0', 'Lamp B', 0, false],
  ])
  const s = e.track('shrpc:a:0')
  e.editSig(s.id, { name: 'Study lights' })
  e.combine(s.id, 'shrpc:b:0')
  assert.deepEqual(e.devsOf(s), ['shrpc:a:0', 'shrpc:b:0'])
  const v = () => e.view().sigs.find(x => x.id === s.id)
  assert.equal(v().devName, 'Lamp A + Lamp B')
  assert.equal(v().devs.length, 2)
  t += 1000
  src([
    ['shrpc:a:0', 'Lamp A', 40, true],
    ['shrpc:b:0', 'Lamp B', 0, false],
  ])
  assert.equal(e.meter[s.id].w, 40)
  t += 1000
  src([
    ['shrpc:a:0', 'Lamp A', 40, true],
    ['shrpc:b:0', 'Lamp B', 25, true],
  ])
  assert.equal(e.meter[s.id].w, 65, 'watts added up')
  assert.equal(e.meter[s.id].on, true)
  t += 1000
  src([
    ['shrpc:a:0', 'Lamp A', 0, false],
    ['shrpc:b:0', 'Lamp B', 25, true],
  ])
  assert.equal(e.meter[s.id].on, true, 'on while either is on')
  assert.ok(
    !e.view().devices.some(d => !d.tracked && d.id.startsWith('shrpc:')),
    'both devices count as tracked (not in "Found")',
  )
  assert.throws(() => e.combine(s.id, 'shrpc:b:0'), /part of "Study lights" already/)
  assert.throws(() => e.track('shrpc:b:0'), /tracked already/)
  // taking one out: the other stays
  e.separate(s.id, 'shrpc:a:0')
  assert.deepEqual(e.devsOf(s), ['shrpc:b:0'])
  assert.equal(s.alsoDevs, undefined)
  e.separate(s.id, 'shrpc:b:0')
  assert.equal(s.devId, undefined, 'the last one out: back to steps')
  // two switch-only lamps with learned watts: each adds its own when on
  e.devEst['shk:c:1'] = {
    ws: [60, 60, 60],
    n: 3,
    skip: 0,
    small: 0,
    t: 1,
  }
  e.devEst['shk:d:1'] = {
    ws: [9, 9, 9],
    n: 3,
    skip: 0,
    small: 0,
    t: 1,
  }
  t += 1000
  src([
    ['shk:c:1', 'Hall lamp', null, false],
    ['shk:d:1', 'Hall strip', null, false],
    ['shk:x:1', 'New lamp', null, false],
  ])
  const h = e.track('shk:c:1')
  e.combine(h.id, 'shk:d:1')
  assert.equal(h.estimated, true)
  t += 1000
  src([
    ['shk:c:1', 'Hall lamp', null, true],
    ['shk:d:1', 'Hall strip', null, true],
    ['shk:x:1', 'New lamp', null, false],
  ])
  assert.equal(e.meter[h.id].w, 69)
  t += 1000
  src([
    ['shk:c:1', 'Hall lamp', null, false],
    ['shk:d:1', 'Hall strip', null, true],
    ['shk:x:1', 'New lamp', null, false],
  ])
  assert.equal(e.meter[h.id].w, 9)
  assert.throws(() => e.combine(h.id, 'shk:x:1'), /No watts learned for "New lamp"/)
  e.combine(h.id, 'shk:x:1', 15)
  assert.equal(h.estW, 84, 'typed watts: the total with all of them on')
  // a measuring plug joins: the appliance is measured; the switch-only lamp adds its learned watts when on
  e.separate(h.id, 'shk:x:1')
  t += 1000
  src([
    ['shk:c:1', 'Hall lamp', null, true],
    ['shk:d:1', 'Hall strip', null, false],
    ['shrpc:e:0', 'Floor lamp', 30, true],
  ])
  delete h.estW
  e.combine(h.id, 'shrpc:e:0')
  assert.equal(h.estimated, undefined)
  t += 1000
  src([
    ['shk:c:1', 'Hall lamp', null, true],
    ['shk:d:1', 'Hall strip', null, false],
    ['shrpc:e:0', 'Floor lamp', 30, true],
  ])
  assert.equal(e.meter[h.id].w, 90)
  // the combination is kept through a save and a restart
  e.save()
  const e2 = new Engine({ file: e.file, log: quiet })
  assert.deepEqual(e2.devsOf(e2.sigById(h.id)), ['shk:c:1', 'shk:d:1', 'shrpc:e:0'])
})

it(
  'cycles: a dishwasher\'s Eco and Quick are learned apart; time left follows the one it\'s in; a quick run isn\'t "unusual"',
  () => {
    const e = mk()
    let t = Date.now() - 30 * 3600e3
    t = plugRun(e, t, 600, () => 0.5, 'shrpc:dw1:0', 'Dishwasher')
    const s = e.track('shrpc:dw1:0')
    e.editSig(s.id, { statusType: 'faucet' })
    for (const P of [ECO, QUICK, ECO, QUICK, ECO, QUICK]) {
      t = feed(e, t, P)
      t = feed(e, t, [
        [OFF, 0.5],
      ])
    }
    assert.equal(s.runs, 6)
    assert.equal(s.progs.length, 2)
    assert.equal(s.cycles.length, 6)
    const c = Object.fromEntries(e.view().sigs[0].cycles.map(x => [
      Math.round(x.dur / 60),
      x,
    ]))
    assert.ok(c[150] && c[40], JSON.stringify(Object.keys(c)))
    assert.equal(c[150].n, 3)
    assert.ok(Math.abs(c[150].kwh - 1.15) < 0.1, `${c[150].kwh}`)
    e.nameCycle(s.id, c[150].id, 'Eco')
    e.nameCycle(s.id, c[40].id, 'Quick')
    // part-way through runs: which cycle, and the time left (and the faucet's total)
    for (const [P, m] of [
      [ECO, 2],
      [ECO, 30],
      [QUICK, 20],
      [ECO, 120],
    ]) {
      t = feed(e, t, phases(P, m))
      const cyc = e.cycleNow(s, t)
      const left = e.remainingSec(s.id, t) / 60
      const want = mins(P) - m
      const name = P === ECO
        ? 'Eco'
        : 'Quick'
      if (m < 10) {
        assert.ok(cyc && !cyc.sure, 'too early to tell: shown as "probably…"')
      } else {
        assert.equal(cyc.name, name, `${name} at ${m} min`)
        assert.ok(Math.abs(left - want) <= 3, `${name} at ${m} min: ${Math.round(left)} min left, want ${want}`)
      }
      assert.equal(e.expectedRunSec(s.id, t), cyc.dur)
      t = feed(e, t, rest(P, m))
      t = feed(e, t, [
        [OFF, 0.5],
      ])
    }
    assert.equal(s.runs, 10)
    assert.equal(s.progs.length, 2, 'the checked runs joined their cycles')
    // renaming and forgetting
    assert.deepEqual(s.progs.map(p => p.name).sort(), ['Eco', 'Quick'])
    e.forgetCycle(s.id, c[40].id)
    assert.equal(s.progs.length, 1)
    assert.ok(s.cycles.every(x => x.prog === c[150].id))
    // a different device: its cycles start again
    e.untrack(s.id)
    assert.equal(s.progs, undefined)
  },
)
function rest(P, m) {
  const out = []
  let skip = m
  for (const [mm, w] of P) {
    if (skip >= mm) {
      skip -= mm
      continue
    }
    out.push([mm - skip, w])
    skip = 0
  }
  return out
}

it('learning: a long pause inside a run rejoins the run and is learned, so the next run isn\'t split', () => {
  const e = mk()
  let t = Date.now() - 4 * 3600e3
  t = plugRun(e, t, 30, () => 2)
  const s = e.track('shrpc:plug1:0')
  const cycle = () => {
    t = plugRun(e, t, 600, () => 500)
    t = plugRun(e, t, 480, () => 2)
    t = plugRun(e, t, 600, () => 500)
    t = plugRun(e, t, 1500, () => 2)
  }
  cycle()
  assert.equal(s.runs, 1, 'one run, not two')
  assert.ok(e.finishSecs(s) >= 480 * 1.5 - 5, `finish wait ${e.finishSecs(s)}`)
  assert.equal(e.events.filter(x => x.sig === s.id && x.dir === 'off' && x.run).length, 1, 'one finished run')
  cycle()
  assert.equal(s.runs, 2)
  assert.ok(
    s.recentRuns.every(d => d > 1600),
    JSON.stringify(s.recentRuns),
  )
})

it(
  'learning: the running level from what it rests at after a run; your own figure wins; forget goes back',
  () => {
    const e = mk()
    let t = Date.now() - 3 * 3600e3
    t = plugRun(e, t, 30, () => 3)
    const s = e.track('shrpc:plug1:0')
    t = plugRun(e, t, 300, () => 800)
    plugRun(e, t, 1200, () => 3)
    assert.equal(s.learn.runW, 6)
    assert.equal(e.runLevel(s), 6)
    e.editSig(s.id, { runW: 10, finishMin: 2 })
    assert.equal(e.runLevel(s), 10)
    assert.equal(e.finishSecs(s), 120)
    e.editSig(s.id, { runW: null, finishMin: '' })
    assert.equal(e.runLevel(s), 6)
    assert.equal(e.finishSecs(s), s.learn.finishSec)
    e.forgetLearned(s.id)
    assert.equal(e.runLevel(s), 5)
    assert.equal(e.finishSecs(s), 300)
  },
)

it('learning: a TV with 12 W standby stops counting as running once the standby is learned', () => {
  const e = mk()
  let t = Date.now() - 2 * 3600e3
  t = plugRun(e, t, 30, () => 0, 'shrpc:tv:0', 'TV')
  const s = e.track('shrpc:tv:0')
  t = plugRun(e, t, 1800, () => 110, 'shrpc:tv:0', 'TV')
  assert.ok(e.running[s.id])
  const off = t
  t = plugRun(e, t, 900, () => 12, 'shrpc:tv:0', 'TV')
  assert.ok(!e.running[s.id], 'standby is not running')
  assert.equal(s.learn.standby, 12)
  assert.equal(e.runLevel(s), 24)
  assert.ok(Math.abs(e.lastOffAt[s.id] - off) < 30e3, 'finished when standby began')
  t = plugRun(e, t, 1200, () => 12, 'shrpc:tv:0', 'TV')
  assert.ok(!e.running[s.id])
  // imported figures that differ from the defaults count as your own
  const s2 = e.newSig('Old', {
    metered: true,
    devId: 'x',
    runW: 15,
    finishMin: 5,
  })
  assert.equal(e.runLevel(s2), 15)
  assert.equal(e.finishSecs(s2), 300)
})

it('settings: only home-network addresses, and the step size is limited', () => {
  const e = mk()
  assert.throws(() => e.setSettings({ shellyHosts: '192.168.1.50, 8.8.8.8' }), /home network/)
  assert.throws(
    () =>
      e.setSettings({
        em: { host: 'example.com' },
      }),
    /home network/,
  )
  e.setSettings({
    shellyHosts: 'http://192.168.1.50/, shelly1-test.local 10.0.0.7:80',
    em: { host: '192.168.1.60', channel: 'em1:0' },
    threshold: 3,
  })
  assert.deepEqual(e.settings.shellyHosts, ['192.168.1.50', 'shelly1-test.local', '10.0.0.7:80'])
  assert.equal(e.settings.em.host, '192.168.1.60')
  assert.equal(e.settings.threshold, 10)
})

it('saved and loaded: rounded numbers, nothing lost, an unreadable file kept aside', () => {
  const e = mk()
  let t = Date.now() - 3600e3
  t = run(e, t, 120, () => 0)
  t = run(e, t, 120, () => 900)
  run(e, t, 60, () => 0)
  e.learn(
    e.events.map(x => x.id),
    'Toaster',
    'countertops',
    { room: 'Kitchen' },
  )
  assert.ok(e.save())
  const raw = fs.readFileSync(e.file, 'utf8')
  assert.ok(!/\d\.\d{7,}/.test(raw), 'numbers rounded to 6 decimals')
  const e2 = new Engine({ file: e.file, log: quiet })
  assert.equal(e2.sigs[0].name, 'Toaster')
  assert.equal(e2.sigs[0].room, 'Kitchen')
  assert.ok(e2.settings.rooms.includes('Kitchen'))
  fs.writeFileSync(e.file, '{ broken')
  const e3 = new Engine({ file: e.file, log: quiet })
  assert.equal(e3.sigs.length, 0)
  assert.ok(fs.existsSync(`${e.file}.bad`))
})

it('memory stays bounded over a long run (samples 1 h, minutes 7 days, events 2000)', () => {
  const e = mk()
  let t = Date.now() - 9 * 86400e3
  let w = 0
  // 9 days at one reading every 10 s (the engine caps a gap at 10 s), toggling a load often
  for (let i = 0; i < 9 * 8640; i++) {
    t += 10e3
    if (i % 3 === 0) {
      w = w
        ? 0
        : 500 + (i % 7) * 60
    }
    e.processSample(t, 300 + w)
  }
  assert.ok(e.samples.length <= 361, e.samples.length)
  assert.ok(e.minutes.length <= 7 * 1440 + 1, e.minutes.length)
  assert.ok(e.events.length <= 2000)
  assert.ok(Object.keys(e.energy).length <= 10)
})

it('settings: a Gen1 EM or 3EM clamp chosen on the settings page is kept', () => {
  const e = mk()
  for (const channel of [
    'emeter:1',
    'emeter:2',
    'meter:0',
    'em1:1',
    'em:0',
    'pm1:0',
    'switch:1',
    'sum',
    'auto',
  ]) {
    e.setSettings({
      em: { host: '192.168.1.5', channel },
    })
    assert.equal(e.settings.em.channel, channel)
  }
  e.setSettings({
    em: { host: '192.168.1.5', channel: 'nonsense:9' },
  })
  assert.equal(e.settings.em.channel, 'auto')
})

it('a learned appliance whose off-step was missed doesn\'t run for ever', () => {
  const e = mk()
  const now = Date.now()
  const h = 3600e3
  // usual run 25 min: ended 6 h past it (4x would be under 2 h)
  const fridge = e.newSig('Fridge', {
    watts: 70,
    count: 5,
    recentRuns: [1200, 1500, 1800],
  })
  // usual run 3 h: ended at 4x it, 12 h (6 h past it would be 9 h)
  const dryer = e.newSig('Dryer', {
    watts: 2000,
    count: 5,
    recentRuns: [10800, 10800, 10800],
  })
  // no usual run yet: ended after 24 h
  const heater = e.newSig('Heater', { watts: 1500, count: 1 })
  e.running[fridge.id] = now - 6 * h
  e.running[dryer.id] = now - 11 * h
  e.running[heater.id] = now - 23 * h
  e.checkLong(now)
  assert.ok(e.running[fridge.id], 'fridge: 6 h is within its usual run and 6 h')
  assert.ok(e.running[dryer.id], 'dryer: 11 h is within 4x its usual run')
  assert.ok(e.running[heater.id], 'heater, no usual run: 23 h is within 24 h')
  e.running[fridge.id] = now - 7 * h
  e.running[dryer.id] = now - 13 * h
  e.running[heater.id] = now - 25 * h
  e.checkLong(now)
  assert.ok(!e.running[fridge.id], 'fridge: 7 h is far past its usual runs')
  assert.ok(!e.running[dryer.id], 'dryer: 13 h is past 4x its usual run')
  assert.ok(!e.running[heater.id], 'heater: 25 h with nothing to go by')
  // a missed off-step isn't a run: nothing counted
  assert.equal(fridge.runs, 0)
  assert.deepEqual(fridge.recentRuns, [1200, 1500, 1800])
})

it('a reading time saved while the clock was wrong (in the future) doesn\'t stop the readings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-'))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ format: 'home-energy-1', sigs: [], lastT: Date.now() + 400 * 86400e3 }))
  const e = new Engine({ file, log: quiet })
  const t = Date.now()
  e.processSample(t, 500)
  e.processSample(t + 1000, 510)
  assert.equal(e.now?.p, 510)
  // a few seconds ahead (a clock nudged by NTP) is kept: nothing is counted twice
  fs.writeFileSync(file, JSON.stringify({ format: 'home-energy-1', sigs: [], lastT: Date.now() + 2000 }))
  assert.ok(new Engine({ file, log: quiet }).lastT > Date.now())
})

it('a clock that jumps a year ahead doesn\'t push the real days out of the history', () => {
  const e = mk()
  const now = Date.now()
  for (let i = 0; i < 730; i++) {
    e.energy[dayKey(now - i * 86400e3)] = {
      total: 10,
      apps: {},
      other: 10,
      peak: 0,
      peakT: 0,
    }
  }
  e.processSample(now, 500, null, 1000000)
  e.processSample(now + 1000, 500, null, 1000000)
  e.processSample(now + 400 * 86400e3, 500, null, 1000001) // the clock jumps 400 days ahead
  // all 730 real days are kept, and the empty days in between aren't made
  assert.equal(Object.keys(e.energy).filter(k => k <= dayKey(now)).length, 730)
  assert.equal(Object.keys(e.energy).length, 731)
})

it('power steps, runs and switch estimates are saved with the readings (every 5 minutes); changes made by hand within 30 s', () => {
  const e = mk()
  let t = Date.now() - 3 * 3600e3
  // a kettle learned from steps, then one more run of it: steps, a run start and finish, all readings
  for (let k = 0; k < 3; k++) {
    t = run(e, t, 120, () => 0)
    t = run(e, t, 180, () => 2000)
  }
  t = run(e, t, 120, () => 0)
  e.nameCluster(e.patterns()[0].key, 'Kettle', 'kettle')
  assert.equal(e.dirty, true, 'naming it is a change made by hand')
  e.save()
  const version = e.version
  t = run(e, t, 200, () => 2000)
  t = run(e, t, 60, () => 0)
  assert.equal(e.sigs[0].runs, 4)
  assert.ok(e.version > version, 'the page and the tiles still hear about it')
  assert.equal(e.dataDirty, true)
  assert.equal(e.dirty, false, 'not a reason to rewrite the whole file within 30 s')
  // a switch of an on/off device: its estimate is a reading too
  const relayOn = on => [
    {
      id: 'shk:dev1:0',
      name: 'Garage heater',
      type: 'Switch',
      on,
      values: {},
      protocol: 'shelly',
    },
  ]
  e.save()
  t = run(e, t, 60, () => 0, () => relayOn(false))
  t = run(e, t, 60, () => 1500, () => relayOn(true))
  run(e, t, 60, () => 1500, () => relayOn(true))
  assert.ok(e.devEst['shk:dev1:0'], 'an estimate was learned')
  assert.equal(e.dirty, false)
  // a run of an appliance measured by its own plug: its start is a reading too
  t = plugRun(e, t, 30, () => 2)
  const plug = e.track('shrpc:plug1:0')
  e.save()
  t = plugRun(e, t, 120, () => 2000)
  assert.ok(e.running[plug.id], 'the plug\'s run started')
  assert.equal(e.dirty, false)
})
