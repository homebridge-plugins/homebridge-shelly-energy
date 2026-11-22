// Past days are counted by calendar day. Taking away 24 hours at a time skips a day around the spring clock change: in the
// UK, 29 March 2026 has 23 hours, so at 00:30 on the 30th, "24 hours ago" is still the 28th.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { afterAll, beforeAll, it, vi } from 'vitest'

import { Engine } from './engine.js'
import { insights } from './insights.js'
import { MatterTiles } from './matter-tiles.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
const tz = process.env.TZ
let now

beforeAll(() => {
  process.env.TZ = 'Europe/London'
  now = new Date(2026, 2, 30, 0, 30).getTime() // 00:30 on Monday 30 March, the night after the clock change
})

afterAll(() => {
  vi.useRealTimers()
  if (tz === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = tz
  }
})

function mk() {
  return new Engine({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-dst-')), 's.json'),
    log: quiet,
  })
}
function day(total, apps = {}) {
  return {
    total,
    apps,
    other: 0,
    peak: 0,
    peakT: 0,
  }
}

it('"last 7 days" includes the clock-change day', () => {
  const e = mk()
  for (let d = 22; d <= 30; d++) {
    e.energy[`2026-03-${d}`] = day(d === 29
      ? 100
      : 1)
  }
  const s = e.summary(7, now)
  // the 30th back to the 24th: 6 days of 1 kWh and the 29th's 100
  assert.equal(s.total.kwh, 106)
})

it('money-saving tips count the clock-change day', () => {
  const e = mk()
  for (const d of [27, 28, 29]) {
    e.energy[`2026-03-${d}`] = day(5)
  }
  assert.equal(insights(e, now).days, 3)
})

it('an outlet\'s 24-hour average uses yesterday, also the night after the clock change', () => {
  vi.useFakeTimers({ now })
  const e = mk()
  const s = e.newSig('Fridge')
  e.energy['2026-03-29'] = day(2.4, { [s.id]: 2.4 })
  const tiles = new MatterTiles({ api: {}, log: quiet, engine: e })
  // half an hour into today: almost all of yesterday's 2.4 kWh still counts, about 98 W
  assert.ok(tiles.avg24h(s.id) > 90, String(tiles.avg24h(s.id)))
  vi.useRealTimers()
})
