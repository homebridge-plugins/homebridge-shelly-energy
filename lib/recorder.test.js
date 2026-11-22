// Recording readings for tuning, and replaying a recording through the engine.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { it, vi } from 'vitest'

import { readRecording, replay } from '../test/replay.js'
import { Engine } from './engine.js'
import { privateDir } from './private-dir.js'
import { Recorder } from './recorder.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
const wait = ms => new Promise(r => setTimeout(r, ms))

it('household folders are this account\'s only: new ones, one left open by an older version, and the engine\'s own', () => {
  if (process.platform === 'win32') {
    return
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'he-perm-'))
  const mode = d => fs.statSync(d).mode & 0o777
  const fresh = privateDir(path.join(base, 'a', 'b'))
  assert.equal(mode(fresh), 0o700)
  const open = path.join(base, 'open')
  fs.mkdirSync(open, { mode: 0o755 })
  fs.chmodSync(open, 0o755)
  privateDir(open)
  assert.equal(mode(open), 0o700, 'an open folder from before is closed up')
  const e = new Engine({
    file: path.join(base, 'home-energy', 'state.json'),
    log: quiet,
  })
  e.save()
  assert.equal(mode(path.join(base, 'home-energy')), 0o700)
  assert.equal(fs.statSync(path.join(base, 'home-energy', 'state.json')).mode & 0o777, 0o600)
})

it('a recording: meter readings and device changes (only changes), compressed, private, listed; no addresses; downloaded anonymized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-rec-'))
  const r = new Recorder({ dir, log: quiet, plugin: '1.4.0' })
  r.start(24, { threshold: 40 })
  assert.throws(() => r.start(), /Already recording/)
  let t = Date.now()
  const dev = (on, w) => [
    {
      id: 'shrpc:a:0',
      name: 'Kettle plug',
      type: 'Outlet',
      on,
      values: { Watts: w },
      host: '192.168.1.60',
    },
  ]
  for (let i = 0; i < 10; i++) {
    r.sample((t += 1000), 300, 120)
    r.devices(dev(false, 0), t)
  }
  r.devices(dev(true, 2000), (t += 1000))
  r.stop()
  await wait(200)
  const list = r.list()
  assert.equal(list.length, 1)
  assert.ok(list[0].size > 50)
  assert.equal((fs.statSync(path.join(dir, 'recordings', list[0].name)).mode & 0o777).toString(8), '600')
  const raw = readRecording(fs.readFileSync(path.join(dir, 'recordings', list[0].name))) // the copy kept on this computer
  assert.equal(raw.head.v, 1)
  assert.equal(raw.head.threshold, 40)
  assert.deepEqual(
    raw.lines.filter(x => x[0] === 'd').map(x => [x[3], x[4], x[5]]),
    [
      ['Kettle plug', false, 0],
      [null, true, 2000],
    ],
    'only changes; the name once',
  )
  assert.ok(!JSON.stringify(raw.lines).includes('192.168'), 'no addresses')
  // a download: anonymized
  const { head, lines } = readRecording(
    r.read(list[0].name, {
      kindOf: id => (id === 'shrpc:a:0'
        ? 'kettle'
        : null),
      tzOffsetMin: 780,
    }),
  )
  assert.equal(head.v, 2)
  assert.equal(head.anonymized, true)
  assert.equal(head.tzOffsetMin, 780)
  assert.equal(head.threshold, 40)
  assert.ok(head.format.m && head.format.d)
  assert.equal(head.plugin, undefined)
  assert.equal(lines.filter(x => x[0] === 'm').length, 10)
  assert.deepEqual(
    lines.filter(x => x[0] === 'd').map(x => x.slice(2)),
    [
      [
        'device 1',
        'kettle',
        false,
        0,
        'Outlet',
      ],
      ['device 1', null, true, 2000, null],
    ],
  )
  const text = JSON.stringify([head, lines])
  for (const bad of ['Kettle plug', 'shrpc', '192.168']) assert.ok(!text.includes(bad), `the download has no "${bad}"`)
  assert.throws(() => r.read('../state.json'), /isn't one of/)
  r.remove(list[0].name)
  assert.equal(r.list().length, 0)
})

it('a recording that failed to write doesn\'t cut the next one short', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-rec-'))
  const r = new Recorder({ dir, log: quiet })
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout'],
  })
  try {
    r.start(1)
    r.cur.out.destroy(new Error('disk full')) // the file can't be written
    for (let i = 0; i < 100 && r.cur; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(r.status().on, false, 'the failed one has stopped')
    r.start(2)
    vi.advanceTimersByTime(3600e3 + 1000) // the failed one's hour is up
    assert.equal(r.status().on, true, 'the new one is still recording')
    vi.advanceTimersByTime(3600e3)
    assert.equal(r.status().on, false, 'and stops after its own 2 h')
  } finally {
    r.stop()
    vi.useRealTimers()
  }
})

it('replay: a recorded day goes through the engine; a measured kettle\'s switches are caught by the whole-house meter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-rec-'))
  const r = new Recorder({ dir, log: quiet })
  r.start(24, { threshold: 40 })
  let t = Date.now() - 6 * 3600e3
  const dev = (on, w) => [
    {
      id: 'shrpc:k:0',
      name: 'Kettle plug',
      type: 'Outlet',
      on,
      values: { Watts: w },
    },
  ]
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 600; i++) {
      t += 1000
      r.sample(t, 300 + (i % 5), 100)
      if (i % 3 === 0) {
        r.devices(dev(false, 0), t)
      }
    }
    for (let i = 0; i < 180; i++) {
      t += 1000
      r.sample(t, 2300 + (i % 5), 100)
      if (i % 3 === 0) {
        r.devices(dev(true, 2000), t)
      }
    }
  }
  r.stop()
  await wait(200)
  const out = replay(r.read(r.list()[0].name))
  assert.ok(out.steps >= 7, `${out.steps} steps`)
  assert.equal(out.caught.switches, 7)
  assert.ok(out.caught.share >= 85, JSON.stringify(out.caught))
  assert.ok(out.reactive === 100)
})
