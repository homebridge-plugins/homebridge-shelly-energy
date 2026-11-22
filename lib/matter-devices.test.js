// Matter devices through the stand-in controller (test/fake-matter-worker.js) and the real
// lib/matter-hub.js mapping: pairing, wrong codes, the GRILLPLATS mirror rule, tracking a plug's watts, reuse of Home
// Overview's controller folder, restarts and removal.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { it } from 'vitest'

import { Engine } from './engine.js'
import { MatterDevices } from './matter-devices.js'
import { hubDevices, hubValue } from './matter-hub.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', 'test', 'fake-matter-worker.js')
const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) {
      return true
    }
    await wait(25)
  }
  throw new Error('timed out waiting')
}
const logs = []
const log = {
  info: m => logs.push(['info', m]),
  warn: m => logs.push(['warn', m]),
  error: m => logs.push(['error', m]),
  debug() {},
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'he-mt-'))

it('mapping: the GRILLPLATS mirror is ignored, a split relay and meter are kept, values converted', () => {
  const g = hubDevices([
    {
      number: 1,
      clusters: [0x6, 0x90],
      types: [0x10A],
      children: [],
    },
    {
      number: 2,
      clusters: [0x90],
      types: [0x510],
      children: [],
    },
  ]).devices
  assert.deepEqual(
    g.map(d => d.endpoint),
    [1],
  )
  const split = hubDevices([
    {
      number: 1,
      clusters: [0x6],
      types: [0x10A],
      children: [],
    },
    {
      number: 2,
      clusters: [0x90],
      types: [0x510],
      children: [],
    },
  ]).devices
  assert.deepEqual(
    split.map(d => d.endpoint),
    [1, 2],
  )
  assert.equal(hubValue('watts', 72500), 72.5)
  assert.equal(hubValue('on', 1), true)
})

it(
  'pair a GRILLPLATS-shaped plug and an Eve plug; a wrong code fails clearly; watts reach the device list',
  async () => {
    const dir = tmp()
    const e = new Engine({
      file: path.join(dir, 'state.json'),
      log,
    })
    const md = new MatterDevices({
      engine: e,
      log,
      storageDir: path.join(dir, 'mc'),
      worker: WORKER,
    })
    const a = e.addMatter({ name: 'Grill plug' })
    md.pair(a.id, '1234-567-8901')
    const b = e.addMatter({ name: 'Eve' })
    md.pair(b.id, '20000000000')
    const c = e.addMatter({ name: 'Bad' })
    md.pair(c.id, '99999999999')
    await until(() => a.status === 'connected' && b.status === 'connected' && c.status === 'failed')
    assert.match(c.error, /refused the code/)
    await until(() => ['mhub:42:1', 'mhub:43:1'].every(id => e.devices.some(d => d.id === id && typeof d.values?.Watts === 'number')))
    assert.ok(!e.devices.some(d => d.id === 'mhub:42:2'), 'the mirrored endpoint is not a device')
    assert.equal(e.devices.find(d => d.id === 'mhub:43:1').values.Watts, 72.5)
    assert.equal(e.devices.find(d => d.id === 'mhub:43:1').type, 'Outlet')
    const s = e.track('mhub:43:1')
    assert.equal(s.metered, true)
    await wait(50)
    e.matterPublish()
    assert.equal(e.meter[s.id].w, 72.5)
    md.stop()
  },
)

it(
  'a hub\'s temperature and humidity sensor reaches the device list, for the tiles that need a reading',
  async () => {
    const dir = tmp()
    const e = new Engine({
      file: path.join(dir, 'state.json'),
      log,
    })
    const md = new MatterDevices({
      engine: e,
      log,
      storageDir: path.join(dir, 'mc'),
      worker: WORKER,
    })
    const h = e.addMatter({ name: 'Hub' })
    md.pair(h.id, '30000000000')
    await until(() => e.devices.some(d => d.id === 'mhub:44:4' && d.values.Humidity === 55))
    const d = e.devices.find(x => x.id === 'mhub:44:4')
    assert.equal(d.values.Temperature, 21.5)
    assert.ok(d.type === 'TemperatureSensor' || d.type === 'HumiditySensor', d.type)
    assert.equal(e.sensorAverage('Temperature'), 21.5)
    assert.equal(e.sensorAverage('Humidity'), 55)
    md.stop()
  },
)

it('a plug with its relay and its meter on separate endpoints (GRILLPLATS) is one device with both', async () => {
  const dir = tmp()
  const e = new Engine({
    file: path.join(dir, 'state.json'),
    log,
  })
  const md = new MatterDevices({
    engine: e,
    log,
    storageDir: path.join(dir, 'mc'),
    worker: WORKER,
  })
  const a = e.addMatter({ name: 'Fan' })
  md.pair(a.id, '40000000000')
  await until(() => e.devices.some(d => d.id === 'mhub:45:2' && d.values.Watts === 27 && d.on === true))
  const mine = e.devices.filter(d => d.source === a.id)
  assert.equal(mine.length, 1, JSON.stringify(mine))
  assert.equal(mine[0].name, 'Fan')
  assert.equal(mine[0].type, 'Outlet')
  const s = e.track('mhub:45:2')
  assert.equal(s.estimated, undefined, 'measured, not estimated')
  e.matterValue('45', 1, 'on', false)
  assert.equal(e.meter[s.id].on, false, 'switching it off at the relay counts')
  md.stop()
})

it('after a restart, paired devices reconnect without a code; one no longer paired is reported', async () => {
  const storage = tmp()
  const newDir = path.join(storage, 'home-energy', 'matter-controller')
  fs.mkdirSync(newDir, { recursive: true })
  fs.writeFileSync(path.join(newDir, 'fake-nodes.json'), JSON.stringify(['43']))
  const e = new Engine({
    file: path.join(storage, 'home-energy', 'state.json'),
    log,
  })
  e.matterDevices.push({
    id: 'mtr-old',
    name: 'Kettle plug',
    nodeId: '43',
    status: 'connected',
    error: null,
    product: '',
  })
  e.matterDevices.push({
    id: 'mtr-gone',
    name: 'Gone',
    nodeId: '77',
    status: 'connected',
    error: null,
    product: '',
  })
  const md = new MatterDevices({
    engine: e,
    log,
    storageDir: newDir,
    worker: WORKER,
  })
  md.start()
  // connected, and its parts reported (the controller sends those just after it says it's connected)
  await until(() => e.matterById('mtr-old').status === 'connected' && e.matterById('mtr-gone').status === 'failed'
    && e.devices.some(d => d.id === 'mhub:43:1'))
  assert.match(e.matterById('mtr-gone').error, /no longer paired/)
  assert.ok(e.devices.some(d => d.id === 'mhub:43:1'))
  md.stop()
})

it('a controller that can\'t start is reported once and not restarted in a loop', async () => {
  const dir = tmp()
  const e = new Engine({
    file: path.join(dir, 'state.json'),
    log,
  })
  process.env.HE_FAKE_MATTER_CRASH = '1'
  const md = new MatterDevices({
    engine: e,
    log,
    storageDir: path.join(dir, 'mc'),
    worker: WORKER,
  })
  md.start()
  await until(() => e.matterSystem.ok === false)
  delete process.env.HE_FAKE_MATTER_CRASH
  await wait(300)
  assert.equal(md.running, false)
  assert.match(e.matterSystem.error, /not installed/)
  md.stop()
})

it('the controller restarting: devices show reconnecting, then connect again', async () => {
  const dir = tmp()
  const e = new Engine({
    file: path.join(dir, 'state.json'),
    log,
  })
  const md = new MatterDevices({
    engine: e,
    log,
    storageDir: path.join(dir, 'mc'),
    worker: WORKER,
  })
  const a = e.addMatter({ name: 'Eve' })
  md.pair(a.id, '20000000000')
  await until(() => a.status === 'connected')
  md.child.kill()
  await until(() => a.status === 'reconnecting', 2000)
  await until(() => a.status === 'connected', 8000)
  assert.ok(logs.some(([l, m]) => l === 'warn' && /restarting in 5 s/.test(m)))
  md.unpair(a.nodeId)
  e.removeMatter(a.id)
  assert.ok(!e.devices.some(d => d.id.startsWith('mhub:43')))
  md.stop()
}, 20000)

it('keeps the controller\'s folder (its keys for your devices) for the Homebridge user only', async () => {
  if (process.platform === 'win32') {
    return
  }
  const e = new Engine({
    file: path.join(tmp(), 's.json'),
    log,
  })
  // a folder made before, open to everyone, and a new one
  const old = path.join(tmp(), 'matter-controller')
  fs.mkdirSync(old, { mode: 0o755 })
  fs.chmodSync(old, 0o755)
  const fresh = path.join(tmp(), 'new', 'matter-controller')
  for (const dir of [old, fresh]) {
    const md = new MatterDevices({
      engine: e,
      log,
      storageDir: dir,
      worker: WORKER,
    })
    md.start()
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir)
    md.stop()
  }
})
