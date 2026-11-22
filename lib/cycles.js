// Cycles (programmes) of an appliance measured by its own plug: a dishwasher's Eco and Quick, a washing machine's Cotton and
// Synthetics. Each finished run keeps its power pattern minute by minute; runs with a similar length and pattern are one cycle.
// While a run is going, its pattern so far is compared with each cycle's usual pattern, and the closest gives the time left.
//
// On the appliance (saved): cycles: [{ id, t, dur, kwh, prog, prof: [W per minute, null where unknown] }] (the newest 40),
//                           progs:  [{ id, name }] (at most 12; the figures come from their runs).
import { median, uid } from './engine-util.js'

const MAX_RUNS = 40
const MAX_PROGS = 12
const PER_PROG = 10
const MAX_MIN = 360
const MIN_SECS = 300
const SAME_LEN = [0.8, 1.25]
const SAME_SHAPE = 0.5 // a finished run joins a cycle within these

/** Minute buckets ({ sums, ns }) -> watts per minute for the first `mins` minutes; null where nothing was read. */
export function profile(b, mins) {
  const out = []
  for (let i = 0; i < Math.min(mins, MAX_MIN); i++) {
    out.push(b?.ns?.[i]
      ? Math.round(b.sums[i] / b.ns[i])
      : null)
  }
  return out
}
const kwhOf = prof => prof.reduce((a, w) => a + (w || 0), 0) / 60 / 1000

/**
 * How far apart two patterns are over their first `upto` minutes: the average difference, as a share of the cycle's
 * own average draw (0 = the same). Minutes either doesn't know are skipped; null if too few are left to compare.
 */
export function distance(a, b, upto = Math.min(a.length, b.length)) {
  let diff = 0
  let n = 0
  let sum = 0
  for (let i = 0; i < upto; i++) {
    if (a[i] == null || b[i] == null) {
      continue
    }
    diff += Math.abs(a[i] - b[i])
    sum += b[i]
    n++
  }
  if (n < Math.min(3, upto)) {
    return null
  }
  return diff / n / Math.max(30, sum / n)
}

/** Each cycle's figures from its newest runs: usual length (s), energy (kWh), pattern, runs seen. */
export function progStats(s) {
  return (s.progs || [])
    .map((p) => {
      const runs = (s.cycles || []).filter(c => c.prog === p.id).slice(-PER_PROG)
      if (!runs.length) {
        return null
      }
      const dur = median(runs.map(c => c.dur))
      const mins = Math.ceil(dur / 60)
      const prof = Array.from({
        length: Math.min(mins, MAX_MIN),
      }, (_, i) => {
        const v = runs.map(c => c.prof[i]).filter(x => x != null)
        return v.length
          ? median(v)
          : null
      })
      return {
        id: p.id,
        name: p.name,
        dur: Math.round(dur),
        kwh: Math.round(median(runs.map(c => c.kwh)) * 1000) / 1000,
        n: runs.length,
        prof,
      }
    })
    .filter(Boolean)
}

/** A finished run: kept, and put in the cycle it matches, or a new one. Returns { cycle, prog, isNew }. */
export function addRun(s, { t, dur, buckets }) {
  if (!(dur >= MIN_SECS)) {
    return null
  }
  const prof = profile(buckets, Math.ceil(dur / 60))
  if (prof.filter(x => x != null).length < prof.length * 0.6) {
    return null
  } // mostly unread (a restart mid-run): not a pattern to learn
  let best = null
  for (const p of progStats(s)) {
    const r = dur / p.dur
    if (r < SAME_LEN[0] || r > SAME_LEN[1]) {
      continue
    }
    const d = distance(prof, p.prof)
    if (d == null || d > SAME_SHAPE) {
      continue
    }
    if (!best || d < best.d) {
      best = { p, d }
    }
  }
  s.progs ??= []
  s.cycles ??= []
  let prog = best && s.progs.find(p => p.id === best.p.id)
  let isNew = false
  if (!prog) {
    isNew = true
    const used = new Set(s.progs.map(p => p.name))
    let k = 1
    while (used.has(`Cycle ${k}`)) k++
    prog = {
      id: uid(),
      name: `Cycle ${k}`,
    }
    s.progs.push(prog)
  }
  const cycle = {
    id: uid(),
    t,
    dur: Math.round(dur),
    kwh: Math.round(kwhOf(prof) * 1000) / 1000,
    prog: prog.id,
    prof,
  }
  s.cycles.push(cycle)
  if (s.cycles.length > MAX_RUNS) {
    s.cycles.splice(0, s.cycles.length - MAX_RUNS)
  }
  // at most 12 cycles: the one least used (oldest first) makes room
  while (s.progs.length > MAX_PROGS) {
    const count = id => s.cycles.filter(c => c.prog === id).length
    const drop = s.progs.filter(p => p.id !== prog.id).sort((a, b) => count(a.id) - count(b.id))[0]
    s.progs = s.progs.filter(p => p !== drop)
    s.cycles = s.cycles.filter(c => c.prog !== drop.id)
  }
  s.progs = s.progs.filter(p => s.cycles.some(c => c.prog === p.id)) // a cycle whose runs have all aged out
  return { cycle, prog, isNew }
}
/** Undo addRun (a run that turned out to be a pause inside a longer one). */
export function removeRun(s, cycleId) {
  if (!cycleId || !s.cycles) {
    return
  }
  s.cycles = s.cycles.filter(c => c.id !== cycleId)
  s.progs = (s.progs || []).filter(p => s.cycles.some(c => c.prog === p.id))
}

/**
 * The cycle a run is most likely in, from its pattern so far (minute buckets) and how long it has been going. Early on
 * (or when patterns don't tell them apart) the one seen most often, among those that last longer than this run so far.
 * Returns { id, name, dur, n, sure } or null.
 */
export function matchRun(s, buckets, elapsedSec) {
  const P = progStats(s)
  if (!P.length) {
    return null
  }
  const mins = Math.floor(elapsedSec / 60)
  const so = profile(buckets, mins)
  const fits = P.filter(p => p.dur >= elapsedSec * 0.95)
  const pool = fits.length ? fits : P
  const scored = pool.map(p => ({
    p,
    d: mins >= 3
      ? distance(so, p.prof, Math.min(mins, p.prof.length))
      : null,
  }))
  const known = scored.filter(x => x.d != null)
  let pick
  if (known.length) {
    known.sort((a, b) => a.d - b.d || b.p.n - a.p.n)
    // patterns too alike so far: the more usual of the close ones
    const close = known.filter(x => x.d <= known[0].d + 0.1)
    pick = close.sort((a, b) => b.p.n - a.p.n || a.d - b.d)[0]
    return {
      id: pick.p.id,
      name: pick.p.name,
      dur: pick.p.dur,
      n: pick.p.n,
      sure: close.length === 1,
    }
  }
  pick = scored.sort((a, b) => b.p.n - a.p.n)[0]
  return {
    id: pick.p.id,
    name: pick.p.name,
    dur: pick.p.dur,
    n: pick.p.n,
    sure: scored.length === 1,
  }
}
