// Unnamed repeating power steps and what they might be.
// Pure functions: everything comes in as arguments. Suggestions are never applied automatically.
import { tolFor } from './engine-util.js'

// Broad household rules of thumb, not a model of any particular appliance. w: watts, on/off: typical minutes; load: 'r' a heating
// element (power factor about 1, no start spike), 'm' a motor or compressor (lower power factor, a start spike).
const FINGERPRINTS = [
  {
    name: 'Fridge or freezer',
    load: 'm',
    icon: 'kitchen',
    w: [70, 260],
    on: [8, 50],
    off: [10, 70],
    why: 'A steady low wattage that cycles on and off every 10-50 minutes is the classic sign of a compressor.',
  },
  {
    name: 'Kettle',
    load: 'r',
    icon: 'kettle',
    w: [1700, 3200],
    on: [0.5, 6],
    why: 'Very high wattage for just a minute or two at a time.',
  },
  {
    name: 'Toaster',
    load: 'r',
    icon: 'countertops',
    w: [700, 1500],
    on: [0.5, 5],
    why: 'A short, sharp burst in the small-kitchen-appliance range.',
  },
  {
    name: 'Microwave',
    icon: 'microwave',
    w: [900, 1800],
    on: [0.5, 12],
    why: 'High wattage for a few minutes at a time.',
  },
  {
    name: 'Oven',
    load: 'r',
    icon: 'oven_gen',
    w: [1800, 3200],
    on: [3, 90],
    off: [3, 40],
    why: 'High wattage that cycles on and off while holding temperature.',
  },
  {
    name: 'Hot water cylinder',
    load: 'r',
    icon: 'shower',
    w: [1800, 3200],
    on: [20, 240],
    off: [60, 600],
    why: 'High wattage on for a long stretch, then off for hours: typical of a hot water element.',
  },
  {
    name: 'Clothes dryer',
    icon: 'dry_cleaning',
    w: [1800, 3200],
    on: [25, 100],
    why: 'High wattage sustained for most of an hour or more.',
  },
  {
    name: 'Washing machine',
    load: 'r',
    icon: 'local_laundry_service',
    w: [1700, 2600],
    on: [10, 50],
    why: 'A high-wattage stretch of ten to fifty minutes, likely the heating element of a wash.',
  },
  {
    name: 'Dishwasher',
    load: 'r',
    icon: 'dishwasher_gen',
    w: [900, 2200],
    on: [8, 50],
    why: 'A heating-element burst during part of a wash cycle.',
  },
  {
    name: 'Space heater',
    load: 'r',
    icon: 'heat',
    w: [900, 2400],
    on: [5, 120],
    off: [5, 60],
    why: 'A heater-range wattage cycling on and off on a thermostat.',
  },
  {
    name: 'Heat pump or air conditioner',
    load: 'm',
    icon: 'heat_pump',
    w: [300, 3000],
    on: [30, 600],
    why: 'Runs for a long stretch at a wattage that can vary a lot with an inverter unit.',
  },
  {
    name: 'Pool or spa pump',
    load: 'm',
    icon: 'pool',
    w: [350, 1600],
    on: [60, 600],
    off: [60, 1400],
    why: 'Runs for hours at a time, often on a daily schedule.',
  },
  {
    name: 'EV charger',
    load: 'r',
    icon: 'electric_car',
    w: [1400, 7600],
    on: [60, 600],
    why: 'A big, steady load for hours at a time, likely overnight charging.',
  },
]

function median(a) {
  if (!a.length) {
    return null
  }
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2
    ? s[m]
    : (s[m - 1] + s[m]) / 2
}

function cycleStats(evs) {
  const sorted = [...evs].sort((a, b) => a.t - b.t)
  const onDurs = []
  const offDurs = []
  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (sorted[i].t - sorted[i - 1].t) / 60000
    if (gapMin >= 1440) {
      continue
    }
    if (sorted[i - 1].dir === 'on' && sorted[i].dir === 'off') {
      onDurs.push(gapMin)
    } else if (sorted[i - 1].dir === 'off' && sorted[i].dir === 'on') {
      offDurs.push(gapMin)
    }
  }
  return {
    on: median(onDurs),
    off: median(offDurs),
  }
}

export function guessAppliance(mean, evs, kind = loadKind(evs)) {
  const { on, off } = cycleStats(evs)
  let best = null
  let bestScore = 0
  let second = 0
  for (const p of FINGERPRINTS) {
    if (mean < p.w[0] || mean > p.w[1]) {
      continue
    }
    let score = 2
    if (kind && p.load) {
      score += kind === p.load
        ? 1
        : -3
    } // a heater can't be a pump, and the other way round
    if (on != null && p.on) {
      score += on >= p.on[0] && on <= p.on[1]
        ? 2
        : -3
    }
    if (off != null && p.off) {
      score += off >= p.off[0] && off <= p.off[1]
        ? 1
        : -2
    }
    if (score > bestScore) {
      second = bestScore
      best = p
      bestScore = score
    } else if (score > second) {
      second = score
    }
  }
  if (!best || bestScore < 2 || bestScore - second < 1) {
    return null
  } // nothing fits, or too close to call
  return { name: best.name, icon: best.icon, why: best.why }
}

/** Unnamed steps grouped by size: [{ key, mean, evs, n, on, off, last }], at least 2 steps each, most frequent first. */
export function clusters(events) {
  const un = events.filter(e => !e.sig).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))
  const out = []
  for (const e of un) {
    const w = Math.abs(e.d)
    const c = out[out.length - 1]
    if (c && Math.abs(w - c.mean) < tolFor(c.mean)) {
      c.evs.push(e)
      c.mean = c.evs.reduce((s, x) => s + Math.abs(x.d), 0) / c.evs.length
    } else {
      out.push({
        mean: w,
        evs: [e],
      })
    }
  }
  // the same size but clearly two kinds (heater-like and motor-like, at least two of each): two groups
  const split = []
  for (const c of out) {
    const r = c.evs.filter(e => stepKind(e) === 'r')
    const m = c.evs.filter(e => stepKind(e) === 'm')
    if (r.length >= 2 && m.length >= 2) {
      const rest = c.evs.filter(e => !stepKind(e))
      const big = r.length >= m.length
        ? r
        : m
      for (const [evs, k] of [
        [
          r === big
            ? [
                ...r,
                ...rest,
              ]
            : r,
          'r',
        ],
        [
          m === big
            ? [
                ...m,
                ...rest,
              ]
            : m,
          'm',
        ],
      ]) {
        split.push({ mean: evs.reduce((s, x) => s + Math.abs(x.d), 0) / evs.length, evs, k })
      }
    } else {
      split.push(c)
    }
  }
  return split
    .filter(c => c.evs.length >= 2)
    .sort((a, b) => b.evs.length - a.evs.length)
    .map(c => ({
      key: `w${Math.round(c.mean)}${c.k || ''}`,
      mean: Math.round(c.mean),
      evs: c.evs,
      n: c.evs.length,
      kind: loadKind(c.evs),
      on: c.evs.filter(e => e.dir === 'on').length,
      off: c.evs.filter(e => e.dir === 'off').length,
      last: Math.max(...c.evs.map(e => e.t)),
    }))
}
// one step: 'r' heater-like (power factor 0.93 or more, no start spike), 'm' motor-like (lower power factor, or a start spike of
// half again its size), or null when the meter didn't say enough
export function stepKind(e) {
  if (e.pf == null && e.spike == null) {
    return null
  }
  if ((e.pf != null && e.pf < 0.93) || (e.spike != null && e.spike >= 1.5)) {
    return 'm'
  }
  return e.pf != null && e.pf >= 0.93 && !(e.spike >= 1.3)
    ? 'r'
    : null
}
// steps together: a kind when at least two say so and at least 75% of those that say anything agree
export function loadKind(evs) {
  const k = evs.map(stepKind).filter(Boolean)
  if (k.length < 2) {
    return null
  }
  const r = k.filter(x => x === 'r').length
  return r >= k.length * 0.75
    ? 'r'
    : k.length - r >= k.length * 0.75
      ? 'm'
      : null
}

// a device that switched the same way within 20 s of these steps, at least twice and for at least half of them
function deviceHint(c, devEvents) {
  if (!devEvents?.length) {
    return null
  }
  const counts = new Map()
  for (const e of c.evs) {
    const on = e.dir === 'on'
    const seen = new Set()
    for (const h of devEvents) {
      // newest first
      if (h.t < e.t - 20e3) {
        break
      }
      if (h.on !== on || seen.has(h.id)) {
        continue
      }
      if (e.t >= (h.after ?? h.t) - 20e3 && e.t <= h.t + 20e3) {
        seen.add(h.id)
        const x = counts.get(h.id) || { n: 0, name: h.name }
        x.n++
        counts.set(h.id, x)
      }
    }
  }
  let best = null
  for (const [id, x] of counts) {
    if (!best || x.n > best.n) {
      best = { id, ...x }
    }
  }
  if (!best || best.n < 2 || best.n < c.evs.length * 0.5) {
    return null
  }
  return {
    name: best.name,
    icon: 'power',
    device: best.id,
    why: `"${best.name}" switched at the same moment as this step ${best.n} of ${c.evs.length} times.`,
  }
}

// steps that come on only while an appliance named from steps is running: part of it (a spa's heater while its pump runs, a
// dishwasher's heater, an oven's grill). At least twice, and at least 80% of the time, inside one of its runs.
function partOfHint(c, sigs, events, running, now) {
  const ons = c.evs.filter(e => e.dir === 'on')
  if (ons.length < 2) {
    return null
  }
  let best = null
  for (const s of sigs) {
    if (s.metered || !s.count) {
      continue
    }
    const runs = events
      .filter(e => e.sig === s.id && e.dir === 'off' && e.dur > 0)
      .map(e => [e.t - e.dur * 1000, e.t])
    if (running?.[s.id]) {
      runs.push([running[s.id], now])
    }
    if (!runs.length) {
      continue
    }
    const n = ons.filter(e => runs.some(([a, b]) => e.t > a + 5e3 && e.t < b)).length
    if (n >= 2 && n >= ons.length * 0.8 && (!best || n > best.n)) {
      best = { s, n }
    }
  }
  return (
    best && {
      name: best.s.name,
      icon: best.s.icon || null,
      sig: best.s.id,
      stage: true,
      part: true,
      why: `Comes on only while "${best.s.name}" is running (${best.n} of ${ons.length} times), so it's most likely part of it, like a heater while a pump runs.`,
    }
  )
}

/** The best single suggestion for a cluster, or null. dismissed: [{ name, w }] hidden with ✕ on the settings page. */
export function suggestFor(
  c,
  { sigs = [], devEvents = [], dismissed = [], events = [], running = {}, now = Date.now() } = {},
) {
  const off = name => dismissed.some(d => d.name === name && Math.abs(d.w - c.mean) < tolFor(d.w))
  const h = deviceHint(c, devEvents)
  if (h && !off(h.name)) {
    // a device already tracked as an appliance: these steps are that appliance's, from before it was tracked
    const t = sigs.find(s => s.devId && (s.devId === h.device || (s.alsoDevs || []).includes(h.device)))
    return t
      ? {
          ...h,
          name: t.name,
          icon: t.icon || h.icon,
          sig: t.id,
          why: `${h.why} It's tracked as "${t.name}" already.`,
        }
      : h
  }
  const p = partOfHint(c, sigs, events, running, now)
  if (p && !off(p.name)) {
    return p
  }
  const known = []
  for (const s of sigs) {
    if (s.metered) {
      continue
    } // measured exactly: its steps never need naming
    if (s.count && Math.abs(s.watts - c.mean) < tolFor(s.watts)) {
      known.push({
        diff: Math.abs(s.watts - c.mean),
        sig: s,
        why: `Same size of step as "${s.name}" (about ${Math.round(s.watts)} W), which you've already named.`,
      })
    }
    for (const st of s.stages || []) {
      if (Math.abs(st.watts - c.mean) < tolFor(st.watts)) {
        known.push({
          diff: Math.abs(st.watts - c.mean),
          sig: s,
          stage: true,
          why: `Matches a learned extra stage of "${s.name}" (about ${Math.round(st.watts)} W), like a heating element switching on partway through a run.`,
        })
      }
    }
  }
  const k = known.filter(x => !off(x.sig.name)).sort((a, b) => a.diff - b.diff)[0]
  if (k) {
    return {
      name: k.sig.name,
      icon: k.sig.icon || null,
      sig: k.sig.id,
      stage: !!k.stage,
      why: k.why,
    }
  }
  const g = guessAppliance(c.mean, c.evs)
  if (g && c.kind) {
    g.why
      += c.kind === 'r'
        ? ' Its steps look like a heating element (no start spike, power factor about 1).'
        : ' Its steps look like a motor or compressor.'
  }
  return g && !off(g.name)
    ? g
    : null
}
