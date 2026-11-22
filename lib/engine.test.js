// the energy engine on made-up readings: step detection, naming, stages, runs, anomalies,
// measured and estimated appliances, Other, costs, suggestions, saving and the memory caps.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

import { dayKey, Engine } from './engine.js'
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

it('an unusual run is flagged against the appliance\'s own runs', () => {
  const e = mk()
  let t = Date.now() - 10 * 3600e3
  for (let k = 0; k < 6; k++) {
    t = run(e, t, 60, () => 0)
    t = run(e, t, 120, () => 1000)
  }
  t = run(e, t, 60, () => 0)
  e.learn(
    e.events.map(x => x.id),
    'Heater',
  )
  assert.equal(e.anomalies.length, 0)
  t = run(e, t, 600, () => 1000)
  t = run(e, t, 60, () => 0)
  assert.equal(e.anomalies.length, 1)
  assert.ok(e.anomalies[0].ratio > 2.5)
})

it('a device with its own watts, tracked: exact readings, its step credited, run and finish, standby', () => {
  const e = mk()
  let t = Date.now() - 9 * 60e3
  let w = 0
  const list = () => [
    plug(true, w),
  ]
  t = run(e, t, 30, () => w, list)
  const s = e.track('shrpc:plug1:0')
  assert.equal(s.metered, true)
  assert.equal(s.exposed, false)
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
  'an appliance linked to a device whatever its name; usual runs start again; keep on steps; unusual runs cleared',
  () => {
    const e = mk()
    let t = Date.now() - 9 * 60e3
    const w = 0
    const list = () => [
      plug(true, w),
    ]
    t = run(e, t, 30, () => w, list)
    const s = e.newSig('Spa pump', {
      watts: 900,
      recentRuns: [600, 600, 600, 600, 600],
      relink: true,
    })
    e.anomalies.push(
      {
        id: 'a1',
        t,
        sig: s.id,
        dur: 60,
        base: 600,
        ratio: 0.1,
      },
      {
        id: 'a2',
        t,
        sig: s.id,
        dur: 60,
        base: 600,
        ratio: 0.1,
      },
    )
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
    e.dismissAnomaly('a1')
    assert.deepEqual(
      e.anomalies.map(a => a.id),
      ['a2'],
    )
    e.dismissAnomaly()
    assert.equal(e.anomalies.length, 0)
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
    assert.equal(e.anomalies.length, 0, 'the quick runs are a cycle of their own, not unusual')
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
    assert.equal(e.anomalies.length, 0)
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
