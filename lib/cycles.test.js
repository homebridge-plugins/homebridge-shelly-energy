// learning cycles from runs that vary like real ones (length, heating time, noise).

import assert from 'node:assert/strict'

import { it } from 'vitest'

import { addRun, distance, matchRun, progStats, removeRun } from './cycles.js'

let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const jit = (v, f) => v * (1 + (rnd() * 2 - 1) * f)
// a run as minute watts: [minutes, W] phases, each length and level varied
function run(P) {
  return P.flatMap(([m, w]) =>
    Array.from(
      {
        length: Math.max(1, Math.round(jit(m, 0.08))),
      },
      () => Math.round(Math.max(0, jit(w, 0.15))),
    ),
  )
}
function buckets(prof) {
  return {
    sums: prof.slice(),
    ns: prof.map(() => 1),
  }
}
const COTTON = [
  [4, 60],
  [18, 2100],
  [50, 150],
  [8, 400],
  [12, 120],
  [6, 600],
] // fill, heat, wash, rinse spins, spin
const SYNTH = [
  [4, 60],
  [8, 1900],
  [30, 140],
  [10, 450],
]
const RINSE = [
  [3, 60],
  [12, 160],
  [5, 600],
]

it('a washing machine\'s three programmes, run 24 times with real-world variation, are three cycles', () => {
  const s = {}
  let t = 0
  for (let i = 0; i < 24; i++) {
    const P = [COTTON, SYNTH, RINSE][i % 3]
    const prof = run(P)
    addRun(s, {
      t: (t += 864e5),
      dur: prof.length * 60,
      buckets: buckets(prof),
    })
  }
  const P = progStats(s).sort((a, b) => b.dur - a.dur)
  assert.equal(P.length, 3, P.map(p => `${p.name} ${Math.round(p.dur / 60)} min ×${p.n}`).join(', '))
  assert.deepEqual(
    P.map(p => p.n),
    [8, 8, 8],
  )
  assert.ok(
    Math.abs(P[0].dur / 60 - 98) < 8 && Math.abs(P[1].dur / 60 - 52) < 6 && Math.abs(P[2].dur / 60 - 20) < 4,
    P.map(p => p.dur / 60).join(),
  )
})

it(
  'part-way through a varied run, the right programme is picked once the patterns differ, and time left is close',
  () => {
    const s = {}
    let t = 0
    for (let i = 0; i < 18; i++) {
      const P = [COTTON, SYNTH, RINSE][i % 3]
      const prof = run(P)
      addRun(s, {
        t: (t += 864e5),
        dur: prof.length * 60,
        buckets: buckets(prof),
      })
    }
    let right = 0
    let total = 0
    const errs = []
    for (let k = 0; k < 30; k++) {
      const [P, label] = [
        [COTTON, 'cotton'],
        [SYNTH, 'synth'],
        [RINSE, 'rinse'],
      ][k % 3]
      const prof = run(P)
      for (const m of [6, 15, 30]) {
        if (m >= prof.length - 2) {
          continue
        }
        const got = matchRun(s, buckets(prof.slice(0, m)), m * 60)
        const wantDur = { cotton: 98, synth: 52, rinse: 20 }[label]
        total++
        if (Math.abs(got.dur / 60 - wantDur) < 10) {
          right++
        } else {
          errs.push(`${label}@${m}: ${Math.round(got.dur / 60)}`)
        }
      }
    }
    assert.ok(right / total >= 0.9, `${right}/${total} right: ${errs.join(', ')}`)
  },
)

it('a short or mostly unread run isn\'t learned; undoing a run takes it back out', () => {
  const s = {}
  assert.equal(
    addRun(s, {
      t: 1,
      dur: 120,
      buckets: buckets([500, 500]),
    }),
    null,
    'under 5 minutes',
  )
  assert.equal(
    addRun(s, {
      t: 1,
      dur: 1200,
      buckets: {
        sums: [500],
        ns: [1],
      },
    }),
    null,
    'nothing read for most of it',
  )
  const r = addRun(s, {
    t: 1,
    dur: 1200,
    buckets: buckets(Array.from({ length: 20 }).fill(500)),
  })
  assert.ok(r.isNew)
  removeRun(s, r.cycle.id)
  assert.equal(s.cycles.length, 0)
  assert.equal(s.progs.length, 0)
  assert.equal(distance([1, 2], [1, 2], 2), 0)
  assert.equal(distance([null, null, null], [1, 2, 3]), null)
})

it('at most 12 cycles: the least used makes room', () => {
  const s = {}
  for (let i = 0; i < 14; i++) {
    const m = Math.round(10 * 1.3 ** i)
    addRun(s, {
      t: i,
      dur: m * 60,
      buckets: buckets(Array.from({ length: m }).fill(500)),
    })
  } // each 30% longer: 14 different cycles
  assert.equal(s.progs.length, 12)
  assert.ok(s.cycles.length <= 40)
})
