// Not losing energy or data: gaps filled from the meter's own count, the daily check against that
// count, the meter's count read from each kind of Shelly, saving in two files (older days only when they change), and
// falling back to the earlier copy when a saved file is damaged.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

import { dayKey, Engine } from './engine.js'
import { parseChannels, parseGen1 } from './shelly-em.js'

const logs = []
const log = {
  info() {},
  debug() {},
  warn: m => logs.push(m),
  error: m => logs.push(m),
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'he-data-'))
function mk(dir = tmp()) {
  return new Engine({
    file: path.join(dir, 'state.json'),
    log,
  })
}
const T0 = new Date(2026, 10, 18, 9, 0, 0).getTime()
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

it('the meter\'s own count: Gen2+ clamps and 3-phase, plugs, Gen1 EM (Wh) and Gen1 plugs (watt-minutes)', () => {
  const c = parseChannels({
    'em1:0': { act_power: 500 },
    'em1data:0': { total_act_energy: 1000.5 },
    'em:0': { total_act_power: 900 },
    'emdata:0': { total_act: 2000 },
    'switch:0': {
      apower: 10,
      aenergy: { total: 30 },
    },
    'pm1:0': { apower: 5 },
  })
  assert.deepEqual(
    c.map(x => [x.key, x.wh]),
    [
      ['em1:0', 1000.5],
      ['em:0', 2000],
      ['switch:0', 30],
      ['pm1:0', null],
    ],
  )
  assert.equal(parseChannels({
    'em1:0': { act_power: 1 },
    'em1data:0': { total_act_energy: -5 },
  })[0].wh, null) // nonsense is ignored
  const g = parseGen1({
    emeters: [
      { power: 100, total: 5000 },
      { power: 50, total: 700 },
    ],
    meters: [
      { power: 20, total: 600 },
    ],
  })
  assert.deepEqual(
    g.map(x => x.wh),
    [5000, 700, 10],
  )
})

it('a gap of a few minutes is filled from the meter\'s count, hour by hour, onto Other; small gaps are not', () => {
  const e = mk()
  let t = T0
  let wh = 50000
  const step = (secs, w) => {
    for (let i = 0; i < secs; i++) {
      t += 1000
      wh += w / 3600
      e.processSample(t, w, null, wh)
    }
  }
  step(60, 1200)
  const d0 = structuredClone(e.energy[dayKey(t)])
  // 30 minutes with no readings across the 09:30 → 10:00 boundary would be one hour; make it cross 10:00
  const gapStart = t
  t = new Date(2026, 10, 18, 10, 20).getTime()
  const gapH = (t - gapStart) / 3.6e6
  wh += 2000 * gapH // 2 kW while nothing was heard
  e.processSample(t, 1200, null, wh)
  const d = e.energy[dayKey(t)]
  const filled = d.fill
  near(filled, 2 * gapH - (1.2 * 10) / 3600, 1e-6) // the count, less the 10 s the reading itself is credited with
  near(d.total - d0.total, 2 * gapH, 1e-6)
  near(d.other - d0.other, filled + (1.2 * 10) / 3600, 1e-3)
  assert.ok(d.h[9] > d0.h[9] && d.h[10] > 0, 'spread over both hours')
  near(d.miss, (t - gapStart) / 1000 - 10, 1e-6)
  const before = d.fill
  step(5, 1200)
  t += 8000
  wh += (1200 * 8) / 3600
  e.processSample(t, 1200, null, wh) // 8 s: not a gap
  assert.equal(e.energy[dayKey(t)].fill, before)
})

it('no fill without a count, after a reset, from another meter, or from a count that jumps impossibly', () => {
  const e = mk()
  let t = T0
  e.processSample(t, 500)
  t += 600e3
  e.processSample(t, 500) // a Gen1 plug as the meter with no count: the gap is only noted
  assert.equal(e.energy[dayKey(t)].fill, undefined)
  near(e.energy[dayKey(t)].miss, 590)
  e.processSample((t += 1000), 500, null, 9000)
  t += 600e3
  e.processSample(t, 500, null, 100) // the count went down: a reset
  assert.equal(e.energy[dayKey(t)].fill, undefined)
  assert.equal(e.energy[dayKey(t)].whReset, true)
  assert.equal(e.lastWh, 100)
  t += 600e3
  e.processSample(t, 500, null, 100 + 1e6) // 1000 kWh in 10 minutes: not believed
  assert.equal(e.energy[dayKey(t)].fill, undefined)
  e.processSample((t += 1000), 500, null, 5000)
  e.setSettings({
    em: { host: '192.168.1.50', channel: 'auto' },
  })
  assert.equal(e.lastWh, null) // another meter
  t += 600e3
  e.processSample(t, 500, null, 9000)
  assert.equal(e.energy[dayKey(t)].fill, undefined)
})

it('a restart: the gap while Homebridge was off is filled, as the last count is saved', () => {
  const dir = tmp()
  const e = mk(dir)
  let t = T0
  for (let i = 0; i < 30; i++) e.processSample((t += 1000), 800, null, 1000 + i)
  e.save()
  const e2 = mk(dir)
  assert.equal(e2.lastWh, 1029)
  t += 3600e3
  e2.processSample(t, 800, null, 1029 + 900) // off for an hour, 900 Wh used meanwhile
  near(e2.energy[dayKey(t)].fill, 0.9 - (0.8 * 10) / 3600, 1e-6)
})

it('the check against the meter\'s count: how far apart, over full days that have it', () => {
  const e = mk()
  const now = new Date(2026, 10, 18, 12).getTime()
  assert.equal(e.meterCheck(now), null)
  for (let i = 1; i <= 3; i++) {
    e.energy[dayKey(now - i * 86400e3)] = {
      total: 10,
      apps: {},
      other: 0,
      peak: 0,
      peakT: 0,
      seen: 9.8,
      fill: 0.1,
      wh0: 1000 * i,
      wh1: 1000 * i + 10000,
    }
  }
  const c = e.meterCheck(now)
  assert.equal(c.days, 3)
  near(c.meter, 30)
  near(c.ours, 29.7)
  near(c.pct, -1)
  e.energy[dayKey(now - 86400e3)].whReset = true
  assert.equal(e.meterCheck(now).days, 2)
  const h = e.health(now)
  assert.equal(h.check.days, 2)
  assert.equal(h.counter, false)
})

it('saving: today and yesterday in state.json, older days in state-history.json, written only when they change; both load back', () => {
  const dir = tmp()
  const e = mk(dir)
  const now = Date.now()
  const day = 86400e3
  for (let i = 0; i < 5; i++) {
    e.energy[dayKey(now - i * day)] = {
      total: i + 1,
      apps: {},
      other: 0,
      peak: 0,
      peakT: 0,
    }
  }
  e.save()
  const main = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'state-history.json'), 'utf8'))
  assert.deepEqual(Object.keys(main.energy).sort(), [
    dayKey(now - day),
    dayKey(now),
  ])
  assert.equal(Object.keys(hist.energy).length, 3)
  assert.ok(e.savedBytes > 0 && e.histBytes > 0)
  const hf = path.join(dir, 'state-history.json')
  const old = new Date(Date.now() - 60e3)
  fs.utimesSync(hf, old, old)
  const m1 = fs.statSync(hf).mtimeMs
  e.energy[dayKey(now)].total = 99
  e.save()
  assert.equal(fs.statSync(hf).mtimeMs, m1, 'older days unchanged: not written again')
  e.energy[dayKey(now - 4 * day)].total = 42
  e.save()
  assert.ok(fs.statSync(hf).mtimeMs > m1 + 30e3, 'an older day changed: written')
  const e2 = mk(dir)
  assert.equal(Object.keys(e2.energy).length, 5)
  assert.equal(e2.energy[dayKey(now)].total, 99)
  assert.equal(e2.energy[dayKey(now - 4 * day)].total, 42)
  assert.equal(e2.toData().energy[dayKey(now - 4 * day)].total, 42, 'a backup still has every day')
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.prev')) {
      assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0, `${f} is private`)
    }
  }
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')))
})

it('an older save file (every day in state.json) still loads, and is split on the next save', () => {
  const dir = tmp()
  const now = Date.now()
  const energy = Object.fromEntries(
    [0, 1, 2, 3].map(i => [
      dayKey(now - i * 86400e3),
      {
        total: 1,
        apps: {},
        other: 0,
        peak: 0,
        peakT: 0,
      },
    ]),
  )
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      format: 'home-energy-1',
      settings: {},
      sigs: [],
      energy,
    }),
  )
  const e = mk(dir)
  assert.equal(Object.keys(e.energy).length, 4)
  e.save()
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).energy).length, 2)
  assert.equal(Object.keys(mk(dir).energy).length, 4)
})

it('a damaged save file: kept as .bad, the copy from up to a day earlier used, and that shows in Settings', () => {
  const dir = tmp()
  const e = mk(dir)
  e.sigs.push({
    id: 'a1',
    name: 'Kettle',
    stages: [],
    kwh: 1,
  })
  e.save() // first save: no earlier file to keep
  assert.ok(!fs.existsSync(path.join(dir, 'state.json.prev')))
  e.sigs.push({
    id: 'a2',
    name: 'Dryer',
    stages: [],
    kwh: 2,
  })
  e.save() // replaces a good file: it's kept as .prev (once a day)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.prev'), 'utf8')).sigs.length, 1)
  e.sigs.push({
    id: 'a3',
    name: 'Oven',
    stages: [],
    kwh: 3,
  })
  e.save()
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'state.json.prev'), 'utf8')).sigs.length,
    1,
    'not replaced again the same day',
  )
  fs.writeFileSync(path.join(dir, 'state.json'), '{"format":"home-ener') // cut short, as by a power cut
  logs.length = 0
  const e2 = mk(dir)
  assert.deepEqual(
    e2.sigs.map(s => s.name),
    ['Kettle'],
  )
  assert.ok(fs.existsSync(path.join(dir, 'state.json.bad')))
  assert.match(logs.join(' '), /copy from up to a day earlier/)
  assert.equal(e2.health().recovered.what, 'data')
  fs.writeFileSync(path.join(dir, 'state.json'), 'x')
  fs.unlinkSync(path.join(dir, 'state.json.prev'))
  logs.length = 0
  const e3 = mk(dir)
  assert.equal(e3.sigs.length, 0)
  assert.match(logs.join(' '), /no earlier copy/)
  assert.equal(e3.health().recovered.fresh, true)
})

it('a meter whose count moves once a minute: the part already counted before the gap isn\'t counted twice', () => {
  const e = mk()
  let t = T0
  let wh = 1000
  let real = 0
  const step = (secs, w) => {
    for (let i = 0; i < secs; i++) {
      t += 1000
      real += w / 3600
      if (t % 60000 === 0) {
        wh = 1000 + real
      }
      e.processSample(t, w, null, wh)
    }
  }
  step(90, 3600) // 1 Wh a second; the count last moved 30 s ago
  const before = e.energy[dayKey(t)].total
  t += 300e3
  real += 300
  wh = 1000 + real
  e.processSample(t, 3600, null, wh) // 5 minutes away, then a fresh count
  near(e.energy[dayKey(t)].total - before, 0.3, 1e-6) // exactly the 300 Wh of the gap, not 330
})

it('changing the meter leaves today out of the check; the good earlier copy survives the save after a recovery', () => {
  const e = mk()
  e.processSample(Date.now(), 100, null, 5000)
  e.processSample(Date.now() + 1000, 100, null, 5001)
  e.setSettings({
    em: { host: '192.168.1.51', channel: 'auto' },
  })
  assert.equal(e.energy[dayKey(Date.now())].whReset, true)
  const dir = tmp()
  const a = mk(dir)
  a.sigs.push({
    id: 'k',
    name: 'Kettle',
    stages: [],
    kwh: 0,
  })
  a.save()
  a.sigs.push({
    id: 'd',
    name: 'Dryer',
    stages: [],
    kwh: 0,
  })
  a.save()
  const prev = path.join(dir, 'state.json.prev')
  const old = new Date(Date.now() - 3 * 86400e3)
  fs.utimesSync(prev, old, old) // the copy is days old
  fs.writeFileSync(path.join(dir, 'state.json'), '{bad')
  const b = mk(dir)
  assert.equal(b.sigs.length, 1)
  fs.writeFileSync(path.join(dir, 'state.json'), '{still bad')
  b.save() // the save replaces the damaged file; .prev must stay the good copy
  assert.equal(JSON.parse(fs.readFileSync(prev, 'utf8')).sigs.length, 1)
})

it('a Gen1 EM or 3EM clamp chosen on the settings page is kept (not put back to "auto")', () => {
  const e = mk()
  for (const ch of ['emeter:1', 'meter:0', 'em1:1', 'sum']) {
    e.setSettings({
      em: { host: '192.168.1.50', channel: ch },
    })
    assert.equal(e.settings.em.channel, ch)
  }
  e.setSettings({
    em: { host: '192.168.1.50', channel: 'nonsense' },
  })
  assert.equal(e.settings.em.channel, 'auto')
})

it('a learned appliance whose switch-off was missed doesn\'t stay running for ever; one a device measures is left alone', () => {
  const e = mk()
  const now = Date.now()
  e.sigs.push(
    {
      id: 'k',
      name: 'Lamp',
      watts: 60,
      stages: [],
      kwh: 0,
    },
    {
      id: 'm',
      name: 'Freezer',
      watts: 90,
      stages: [],
      kwh: 0,
      metered: true,
      devId: 'x',
    },
  )
  e.running.k = now - 23 * 3600e3
  e.running.m = now - 30 * 3600e3
  e.checkLong(now)
  assert.ok(e.running.k, '23 h with no usual run yet: still running')
  e.running.k = now - 25 * 3600e3
  e.checkLong(now)
  assert.equal(e.running.k, undefined, '25 h: ended')
  assert.equal(e.sigById('k').oddEnds, 1)
  assert.ok(e.running.m, 'measured by its device: not touched')
})

it('power steps and runs are saved with the readings (every 5 minutes), not within 30 s; your own changes still are', () => {
  const e = mk()
  e.dirty = false
  e.dataDirty = false
  e.handleEvent(Date.now(), 1200, {})
  assert.equal(e.events.length, 1)
  assert.equal(e.dirty, false)
  assert.equal(e.dataDirty, true)
  e.setSettings({ threshold: 50 })
  assert.equal(e.dirty, true)
})

it('saves write each file by its path inside the storage folder, never through a bare file number', () => {
  const dir = tmp()
  const e = mk(dir)
  e.energy[dayKey(T0)] = { total: 1, apps: {}, other: 0, peak: 0, peakT: 0 }
  const targets = []
  const real = fs.writeFileSync
  fs.writeFileSync = function (p, ...rest) {
    targets.push(p)
    return real.call(this, p, ...rest)
  }
  try {
    e.save()
  } finally {
    fs.writeFileSync = real
  }
  assert.ok(targets.length > 0)
  for (const p of targets) {
    assert.equal(typeof p, 'string', `written through ${p}`)
    assert.ok(p.startsWith(dir), `${p} is inside the storage folder`)
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).format, 'home-energy-1')
})
