// node test/replay.js <recording.jsonl.gz> [--json] - plays a recording (Settings → Data → Record readings) through a fresh
// engine and reports how it did: steps found, how they group and what they might be, the watts learned for switches (and why
// any were skipped), and, where devices measure their own watts, how many of their switches the whole-house meter caught as
// steps of the right size. That last one is the score to tune the engine against.
/* eslint-disable no-console -- a script run by hand */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'

import { Engine } from '../lib/engine.js'

/** Read a recording file into { head, lines }. */
export function readRecording(buf) {
  const rows = zlib
    .gunzipSync(buf)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
  return {
    head: rows[0],
    lines: rows.slice(1),
  }
}

export function replay(buf, { threshold } = {}) {
  const { head, lines } = readRecording(buf)
  const e = new Engine({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-replay-')), 'state.json'),
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  })
  if (threshold ?? head.threshold) {
    e.setSettings({ threshold: threshold ?? head.threshold })
  }
  const devs = new Map()
  const switches = []
  let first = null
  let last = null
  let readings = 0
  let withQ = 0
  for (const x of lines) {
    if (x[0] === 'm') {
      const [, t, p, q] = x
      first ??= t
      last = t
      readings++
      if (q != null) {
        withQ++
      }
      e.processSample(t, p, q)
    } else if (x[0] === 'd') {
      const [, t, id, name, on, w, type] = x
      const prev = devs.get(id) || {
        id,
        name: name || id,
        type: type || 'Device',
        values: {},
        protocol: 'shelly',
      }
      if (name) {
        prev.name = name
      }
      if (type) {
        prev.type = type
      }
      const before = prev.values.Watts ?? (prev.on ? null : 0)
      prev.on = on ?? undefined
      prev.values = w == null
        ? {}
        : { Watts: w }
      devs.set(id, prev)
      if (w != null && before != null) {
        switches.push({
          t,
          id,
          name: prev.name,
          d: w - before,
        })
      }
      e.setSource('rec', [
        ...devs.values(),
      ], t)
    }
  }
  // the score: measured devices' changes of at least the step size, and whether a step of about that size was found within 10 s
  const th = e.settings.threshold
  const big = switches.filter(s => Math.abs(s.d) >= th * 1.5)
  const caught = big.filter(s =>
    e.events.some(
      ev =>
        Math.abs(ev.t - s.t) <= 10e3
        && Math.sign(ev.d) === Math.sign(s.d)
        && Math.abs(Math.abs(ev.d) - Math.abs(s.d)) <= Math.max(30, Math.abs(s.d) * 0.2),
    ),
  )
  const steps = e.events.filter(ev => !ev.metered)
  return {
    hours: first
      ? Math.round((last - first) / 360e3) / 10
      : 0,
    readings,
    reactive: readings
      ? Math.round((withQ / readings) * 100)
      : 0,
    threshold: th,
    steps: steps.length,
    withPf: steps.filter(ev => ev.pf != null).length,
    groups: e
      .patterns()
      .map(p => ({
        watts: p.mean,
        n: p.n,
        kind: p.kind || null,
        might: p.suggestion
          ? `${p.suggestion.name}${p.suggestion.part ? ' (part of it)' : ''}`
          : null,
      })),
    switchWatts: Object.entries(e.estSummary()).map(([id, x]) => ({
      device: devs.get(id)?.name || id,
      learned: x.w,
      switches: x.n,
      skipped: x.skip,
      why: x.why,
    })),
    caught: {
      switches: big.length,
      found: caught.length,
      share: big.length
        ? Math.round((caught.length / big.length) * 100)
        : null,
    },
    engine: e,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  if (!file) {
    console.log('usage: node test/replay.js <recording.jsonl.gz> [--json]')
    process.exit(1)
  }
  const r = replay(fs.readFileSync(file))
  delete r.engine
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(
      `${r.hours} h · ${r.readings} readings (${r.reactive}% with reactive power) · step size ${r.threshold} W`,
    )
    console.log(`${r.steps} steps found, ${r.withPf} with a power factor`)
    if (r.caught.switches) {
      console.log(
        `Measured devices' switches caught by the whole-house meter: ${r.caught.found} of ${r.caught.switches} (${r.caught.share}%)`,
      )
    }
    console.log('\nSteps by size:')
    for (const g of r.groups) {
      console.log(
        `  ${String(Math.round(g.watts)).padStart(6)} W ×${String(g.n).padEnd(4)} ${g.kind
          ? `[${g.kind}] `
          : ''}${g.might
          ? `might be: ${g.might}`
          : ''}`,
      )
    }
    if (r.switchWatts.length) {
      console.log('\nSwitches without their own watts:')
      for (const s of r.switchWatts) {
        console.log(
          `  ${s.device}: ${s.learned != null
            ? `${s.learned} W learned`
            : 'not learned'} (${s.switches} used, ${s.skipped} skipped${Object.keys(s.why || {}).length
            ? `: ${JSON.stringify(s.why)}`
            : ''})`,
        )
      }
    }
  }
}
