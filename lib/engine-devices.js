// The engine's devices: appliances measured or switched by their own Shelly or Matter device (runs, cycles, learned levels,
// watts learned from switches), combining and tracking devices, and the Matter devices this plugin reads.
// Installed on Engine.prototype by lib/engine.js, so `this` is the engine.
import { addRun, matchRun, removeRun } from './cycles.js'
import {
  clean,
  MAX_DEV_EVENTS,
  MAX_EVENTS,
  MAX_MATTER,
  MAX_SIGS,
  STALE_READING,
  SWITCH_WINDOW,
} from './engine-shared.js'
import { isSensor, mad, median, uid } from './engine-util.js'

export const deviceMethods = {
  // how long this run should take: its learned cycle's usual length (measured appliances), else the median of recent runs
  expectedRunSec(id, now = Date.now()) {
    const s = this.sigById(id)
    const c = s && this.cycleNow(s, now)
    if (c) {
      return c.dur
    }
    const runs = s?.recentRuns || []
    return runs.length >= 3
      ? median(runs)
      : null
  },
  /**
   * Running far longer than usual right now: twice its usual run (its learned cycle's, or the median of its recent runs), and
   * at least 30 minutes over. Returns { el, usual } in seconds, or null. A fridge left open, a spa heater that won't stop.
   */
  longNow(s, now = Date.now()) {
    const start = this.running[s.id]
    if (!start) {
      return null
    }
    const usual = this.expectedRunSec(s.id, now)
    if (!(usual > 0)) {
      return null
    }
    const el = (now - start) / 1000
    return el > Math.max(2 * usual, usual + 1800)
      ? {
          el: Math.round(el),
          usual: Math.round(usual),
        }
      : null
  },
  // once a minute (index.js): says so in the log, once per run, when a run turns far longer than usual; and ends a run of a
  // learned appliance (not one a device measures) whose switch-off was missed, so it can't stay "running" for ever: after
  // four times its usual run and at least 6 hours over, or after 24 hours when it has no usual run yet
  checkLong(now = Date.now()) {
    for (const s of this.sigs) {
      const start = this.running[s.id]
      if (start && !s.metered && !s.estimated) {
        const usual = this.expectedRunSec(s.id, now)
        const el = (now - start) / 1000
        if (el > (usual > 0
          ? Math.max(4 * usual, usual + 6 * 3600)
          : 24 * 3600)) {
          delete this.running[s.id]
          delete this.impossible[s.id]
          delete this.activeStages[s.id]
          delete this.varBase[s.id]
          delete this.varLow[s.id]
          this.lastOffAt[s.id] = now
          s.oddEnds = (s.oddEnds || 0) + 1
          this.log.info?.(
            `"${this.label(s)}" was still marked running after ${Math.round(el / 3600)} h, so its switch-off was probably missed. It's now shown as off.`,
          )
          this.dataChanged()
          this.emit('finished', s, el)
          continue
        }
      }
      const L = this.longNow(s, now)
      if (!L) {
        continue
      }
      const k = `${s.id}|${this.running[s.id]}`
      this.longSaid ??= new Set()
      if (this.longSaid.has(k)) {
        continue
      }
      this.longSaid.add(k)
      this.emit('long', s, L)
    }
  },
  /** The learned cycle the running appliance is most likely in ({ id, name, dur, n, sure }), or null. Worked out once a minute. */
  cycleNow(s, now = Date.now()) {
    const start = this.running[s.id]
    const b = this.meterRun[s.id]?.buckets
    if (!start || !s.progs?.length || b?.start !== start) {
      return null
    }
    const el = (now - start) / 1000
    const key = `${start}|${Math.floor(el / 60)}|${s.cycles.length}`
    if (this.cycleCache?.[s.id]?.key !== key) {
      (this.cycleCache ??= {})[s.id] = {
        key,
        m: matchRun(s, b, el),
      }
    }
    return this.cycleCache[s.id].m
  },
  nameCycle(id, prog, name) {
    const p = this.sigById(id)?.progs?.find(x => x.id === prog)
    if (!p) {
      throw new Error('Unknown cycle')
    }
    p.name
      = String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40) || p.name
    this.cycleCache = {}
    this.changed()
  },
  forgetCycle(id, prog) {
    const s = this.sigById(id)
    if (!s?.progs?.some(x => x.id === prog)) {
      throw new Error('Unknown cycle')
    }
    s.progs = s.progs.filter(x => x.id !== prog)
    s.cycles = (s.cycles || []).filter(c => c.prog !== prog)
    this.cycleCache = {}
    this.changed()
  },
  remainingSec(id, now = Date.now()) {
    const start = this.running[id]
    if (!start) {
      return null
    }
    const expected = this.expectedRunSec(id, now)
    if (expected == null) {
      return null
    }
    const elapsed = (now - start) / 1000
    return elapsed > expected * 1.5
      ? null
      : Math.max(0, Math.round(expected - elapsed))
  },
  // ---------- measured appliances (a device's own watts, or its on/off state with an estimated or typed figure) ----------
  // a change the size of a whole-house step is remembered so that step is credited to this appliance, not guessed
  meterReading(s, w, on, t = Date.now()) {
    const prev = this.meter[s.id]
    const cur = (this.meter[s.id] = {
      w,
      t,
      on: on === undefined
        ? (prev?.on ?? null)
        : on,
    })
    const before = prev
      ? (prev.on === false
          ? 0
          : prev.w)
      : null
    if (
      before != null
      && cur.on !== false
      && Math.abs((cur.on === false
        ? 0
        : w) - before) >= this.settings.threshold
    ) {
      const d = w - before
      this.meterChanges.push({ sid: s.id, t, d })
      this.tagStep(s.id, t, d)
    } else if (before != null && before >= this.settings.threshold && cur.on === false) {
      this.meterChanges.push({ sid: s.id, t, d: -before })
      this.tagStep(s.id, t, -before)
    }
    while (this.meterChanges.length && this.meterChanges[0].t < t - 5 * 60e3) this.meterChanges.shift()
    this.runCheck(s, t)
  },
  // a device can report a change up to a minute after the whole-house reading shows it
  matchMeterChange(t, d) {
    const c = this.meterChanges.find(
      x =>
        !x.used
        && Math.abs(x.t - t) < 90e3
        && Math.sign(x.d) === Math.sign(d)
        && Math.abs(x.d - d) < Math.max(40, Math.abs(d) * 0.25),
    )
    if (c) {
      c.used = true
      return c.sid
    }
    return null
  },
  tagStep(sid, t, d) {
    const ev = this.events.find(
      e =>
        !e.sig
        && Math.abs(e.t - t) < 90e3
        && Math.sign(e.d) === Math.sign(d)
        && Math.abs(e.d - d) < Math.max(40, Math.abs(d) * 0.25),
    )
    if (ev) {
      ev.sig = sid
      ev.metered = true
      const c = this.meterChanges[this.meterChanges.length - 1]
      if (c) {
        c.used = true
      }
      this.dataChanged()
    }
  },
  // ---------- runs of measured appliances, and what is learned from them ----------
  // Running once the draw has been above the running level for 60 s in total (added up, not in one go, so a drum turning in
  // bursts counts and a few seconds of a pump don't). Finished once it stays below for longer than the programme's longest
  // pause, or at once when switched off at the relay. Ideas from homebridge-appliance-monitor by Oliver Rummeyer (MIT),
  // written here in this plugin's own way:
  //  - finish wait: learned from the longest pause inside a run, plus half, at least 2 minutes; it only ever gets longer
  //  - a run that "finished" and starts again within 10 minutes was one run: rejoined, and the longer pause learned
  //  - running level: learned from what it rests at in the 10 minutes after a run (twice that, at least 5 W)
  //  - standby above the running level: a steady low level (at most 25 W) held 10 minutes, after it has drawn at least three
  //    times that, is standby: the running level becomes twice it
  // A figure typed on the settings page always wins; "Forget what was learned" goes back to the defaults (5 W, 5 minutes).
  runSet(s) {
    return s.runWSet ?? (s.runW != null && s.runW !== 5)
  },
  finishSet(s) {
    return s.finishSet ?? (s.finishMin != null && s.finishMin !== 5)
  },
  runLevel(s) {
    return s.estimated
      ? 0.5
      : this.runSet(s)
        ? s.runW
        : (s.learn?.runW ?? 5)
  },
  finishSecs(s) {
    return s.estimated
      ? 0
      : this.finishSet(s)
        ? s.finishMin * 60
        : (s.learn?.finishSec ?? 300)
  },
  runCheck(s, t) {
    const m = this.meter[s.id]
    if (!m || t - m.t > STALE_READING) {
      return
    }
    const st = (this.meterRun[s.id] ??= {
      above: 0,
      lastT: t,
      belowSince: null,
      pauseMax: 0,
      peak: 0,
      win: [],
    })
    const dt = Math.min(Math.max(0, (t - st.lastT) / 1000), 120)
    st.lastT = t
    const w = m.on === false
      ? 0
      : m.w
    const runW = this.runLevel(s)
    const finishMs = this.finishSecs(s) * 1000
    const running = !!this.running[s.id]
    const L = s.estimated
      ? null
      : (s.learn ??= {})
    if (w > st.peak) {
      st.peak = w
    }
    if (w >= runW) {
      if (running && st.belowSince) {
        st.pauseMax = Math.max(st.pauseMax, t - st.belowSince)
      }
      st.above += dt
      st.belowSince = null
      if (running) {
        s.watts = s.watts
          ? s.watts * 0.95 + w * 0.05
          : w
      } else if (st.above >= (s.estimated ? 0 : 60)) {
        const t0 = t - st.above * 1000
        if (L && st.last?.quiet && t0 - st.last.end < 10 * 60e3) {
          this.meterRejoin(s, st, t0)
        } else {
          this.meterStart(s, t0, w)
        }
      }
    } else {
      st.belowSince ??= t
      if (running && (m.on === false || t - st.belowSince >= finishMs)) {
        this.meterFinish(s, m.on === false
          ? t
          : st.belowSince, m.on !== false)
      } else if (!running && t - st.belowSince > 5 * 60e3) {
        st.above = 0
      }
    }
    // its power pattern minute by minute while it runs (for learning its cycles; lib/cycles.js)
    const start = this.running[s.id]
    if (start && L) {
      const b = st.buckets?.start === start
        ? st.buckets
        : (st.buckets = { start, sums: [], ns: [] })
      const i = Math.floor((t - start) / 60000)
      if (i >= 0 && i < 360) {
        b.sums[i] = (b.sums[i] || 0) + w
        b.ns[i] = (b.ns[i] || 0) + 1
      }
    }
    if (L) {
      this.learnLevels(s, st, L, t, w, m.on)
    }
    // what it draws while idle (below its running level, not running, not switched off at the relay): its standby
    if (!s.estimated && !this.running[s.id] && m.on !== false && w < this.runLevel(s)) {
      s.standbyW = s.standbyW != null
        ? s.standbyW * 0.98 + w * 0.02
        : w
    }
  },
  learnLevels(s, st, L, t, w, on) {
    // running level, from the rest level in the 10 minutes after a run (relay on, not running)
    if (st.rest && !this.running[s.id] && on !== false) {
      st.rest.ws.push(w)
      if (t >= st.rest.until) {
        const rest = st.rest.ws.length >= 5
          ? median(st.rest.ws)
          : null
        st.rest = null
        if (rest != null && (s.watts || st.peak) >= 3 * Math.max(rest, 1)) {
          const lvl = Math.round(Math.max(5, rest * 2) * 10) / 10
          if (lvl !== L.runW && !(L.standby && lvl < L.runW)) {
            L.runW = lvl
            this.dirty = true
          }
        }
      }
    }
    // standby above the running level: a steady low level held 10 minutes
    if (this.runSet(s)) {
      return
    }
    st.win.push([t, w])
    while (st.win.length && st.win[0][0] < t - 10 * 60e3) st.win.shift()
    if (st.win.length < 10 || t - st.win[0][0] < 9.5 * 60e3) {
      return
    }
    const ws = st.win.map(x => x[1])
    const lo = Math.min(...ws)
    const hi = Math.max(...ws)
    const mean = ws.reduce((a, b) => a + b, 0) / ws.length
    if (mean < this.runLevel(s) || mean > 25 || hi - lo > Math.max(1, mean * 0.1) || st.peak < 3 * mean) {
      return
    }
    L.standby = Math.round(mean * 10) / 10
    L.runW = Math.round(mean * 2 * 10) / 10
    this.dirty = true
    const since = st.win[0][0]
    st.win = []
    if (this.running[s.id]) {
      this.meterFinish(s, Math.max(since, this.running[s.id]), true)
    }
    this.emit('learned', s, `standby of about ${L.standby} W, so it counts as running above ${L.runW} W`)
  },
  meterStart(s, t0, w) {
    this.running[s.id] = t0
    s.lastSeen = t0
    if (!s.watts) {
      s.watts = w
    }
    const st = this.meterRun[s.id]
    if (st) {
      st.pauseMax = 0
      st.rest = null
      if (!s.estimated) {
        st.buckets = {
          start: t0,
          sums: [w],
          ns: [1],
        }
      }
    }
    const ev = {
      id: uid(),
      t: t0,
      d: Math.round(w),
      dir: 'on',
      sig: s.id,
      metered: true,
      run: true,
    }
    this.events.unshift(ev)
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS
    }
    this.dataChanged()
    this.emit('event', ev, s)
  },
  meterFinish(s, tEnd, quiet = false) {
    const start = this.running[s.id]
    const dur = Math.max(0, (tEnd - start) / 1000)
    s.runs = (s.runs || 0) + 1
    s.totalSec = (s.totalSec || 0) + dur
    s.count = (s.count || 0) + 1
    delete this.running[s.id]
    this.lastOffAt[s.id] = tEnd
    const st = this.meterRun[s.id]
    let cyc = null
    const ev = {
      id: uid(),
      t: tEnd,
      d: -Math.round(s.watts || 0),
      dir: 'off',
      sig: s.id,
      metered: true,
      run: true,
      dur,
      counted: true,
    }
    this.events.unshift(ev)
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS
    }
    if (st && !s.estimated) {
      // learn its cycle from this run's pattern
      cyc = st.buckets?.start === start
        ? addRun(s, { t: start, dur, buckets: st.buckets })
        : null
      if (cyc?.isNew && s.progs.length > 1) {
        this.emit('learned', s, `a new cycle, "${cyc.prog.name}" (about ${Math.round(dur / 60)} min)`)
      }
      st.above = 0
      st.last = {
        start,
        end: tEnd,
        quiet,
        ev: ev.id,
        dur,
        pauseMax: st.pauseMax,
        cycle: cyc?.cycle.id,
      }
      st.rest = { until: tEnd + 10 * 60e3, ws: [] }
      const L = (s.learn ??= {})
      L.cycles = (L.cycles || 0) + 1
      // the wait before Finished: the longest pause inside the run, plus half, at least 2 minutes; only ever longer
      const want = Math.max(120, Math.round((st.pauseMax / 1000) * 1.5))
      if (L.finishSec == null || want > L.finishSec) {
        L.finishSec = want
      }
      this.dirty = true
    } else if (st) {
      st.above = 0
    }
    this.dataChanged()
    this.emit('event', ev, s)
    this.emit('finished', s, dur)
    this.recordRun(s, dur)
  },
  // it started again within 10 minutes of a quiet finish: that was a pause inside one run, not a new run
  meterRejoin(s, st, t0) {
    const last = st.last
    const gap = t0 - last.end
    const L = (s.learn ??= {})
    this.running[s.id] = last.start
    st.last = null
    st.rest = null
    st.pauseMax = Math.max(last.pauseMax || 0, gap)
    removeRun(s, last.cycle) // learned again when the whole run finishes
    this.events = this.events.filter(e => e.id !== last.ev)
    s.runs = Math.max(0, (s.runs || 0) - 1)
    s.count = Math.max(0, (s.count || 0) - 1)
    s.totalSec = Math.max(0, (s.totalSec || 0) - last.dur)
    if (s.recentRuns?.length && s.recentRuns[s.recentRuns.length - 1] === last.dur) {
      s.recentRuns.pop()
    }
    L.finishSec = Math.max(L.finishSec || 0, Math.max(120, Math.round((gap / 1000) * 1.5)))
    this.dirty = true
    this.changed()
    this.emit(
      'learned',
      s,
      `a ${Math.round(gap / 60000)} min pause inside a run, so it now waits ${Math.round(L.finishSec / 60)} min before calling a run finished`,
    )
  },
  // a device reading that isn't an appliance (a light, say): hidden from "Found, not set up yet", or shown again
  hideDevice(id, hide = true) {
    id = String(id || '').slice(0, 200)
    if (!id) {
      throw new Error('Unknown device')
    }
    const L = new Set(this.settings.devHidden)
    if (hide) {
      L.add(id)
    } else {
      L.delete(id)
    }
    this.settings.devHidden = [...L].slice(-500)
    this.changed()
  },
  // a room for a device that isn't tracked yet ('' = none)
  setDevRoom(id, room) {
    id = String(id || '').slice(0, 200)
    if (!id) {
      throw new Error('Unknown device')
    }
    const r = this.cleanRoom(room || '')
    const R = this.settings.devRooms
    if (r) {
      R[id] = r
      this.noteRoom(r)
    } else {
      delete R[id]
    }
    const keys = Object.keys(R)
    if (keys.length > 500) {
      delete R[keys[0]]
    }
    this.changed()
  },
  forgetLearned(id) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    delete s.learn
    delete this.meterRun[id]
    this.changed()
  },
  // ---------- devices this plugin reads (Shellys and Matter devices) ----------
  // A source ('shelly', 'matter') hands over its full list whenever something in it changes. Each device:
  // { id, name, type, on (bool or undefined), values: { Watts? }, protocol, reachable, model, source }
  setSource(name, list, t = Date.now()) {
    this.sources[name] = Array.isArray(list)
      ? list
      : []
    this.emit('source', name, this.sources[name], t)
    const all = Object.values(this.sources).flat()
    const prev = new Map(this.devices.map(a => [a.id, a]))
    for (const a of all) {
      const p = prev.get(a.id)
      if (!p || typeof a.on !== 'boolean' || typeof p.on !== 'boolean' || a.on === p.on || isSensor(a)) {
        continue
      }
      const after = t - (a.live
        ? 1500
        : (SWITCH_WINDOW[a.protocol] ?? 10e3)) // pushed live: seen within a second or so
      this.devEvents.unshift({
        id: a.id,
        name: a.name,
        on: a.on,
        t,
        after,
      })
      if (typeof a.values?.Watts !== 'number' && typeof p.values?.Watts !== 'number') {
        this.devPending.push({ id: a.id, on: a.on, t, after })
        if (this.devPending.length > 200) {
          this.devPending.shift()
        }
      }
    }
    if (this.devEvents.length > MAX_DEV_EVENTS) {
      this.devEvents.length = MAX_DEV_EVENTS
    }
    this.devices = all
    this.devById = new Map(all.map(a => [a.id, a]))
    for (const s of this.sigs) {
      if (s.devId) {
        this.devReading(s, t)
      }
    }
    this.dataDirty = true
  },
  device(id) {
    return this.devById.get(id)
  },
  /** The average of a reading ('Temperature' or 'Humidity') across the sensors this plugin reads, or null. */
  sensorAverage(key) {
    const v = this.devices
      .filter(a => a.reachable !== false && typeof a.values?.[key] === 'number')
      .map(a => a.values[key])
    return v.length
      ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10
      : null
  },
  // Each switch of an on/off device without its own watts: the whole-house reading 30 s before the change compared with
  // 3-30 s after it (medians). Skipped when another device changed in the same minute, the house was too noisy, or the
  // change window is longer than a minute. The estimate is the median of the last 15 good readings.
  devEstimate(now) {
    const ready = this.devPending.filter(e => now >= e.t + 31e3)
    if (!ready.length) {
      return
    }
    this.devPending = this.devPending.filter(e => now < e.t + 31e3 && now - e.t < 5 * 60e3)
    let changed = false
    for (const e of ready) {
      const est = (this.devEst[e.id] ??= {
        ws: [],
        n: 0,
        skip: 0,
        small: 0,
        t: 0,
      })
      const r = this.devStep(e)
      if (r.skip) {
        est.skip++
        ;(est.why ??= {})[r.skip] = (est.why[r.skip] || 0) + 1
        changed = true
        continue
      } // why, for the settings page
      if (r.small) {
        est.small = (est.small || 0) + 1
        est.n++
        changed = true
        continue
      }
      est.ws.push(Math.round(r.w * 10) / 10)
      if (est.ws.length > 15) {
        est.ws.shift()
      }
      est.n++
      est.t = e.t
      changed = true
    }
    if (changed) {
      this.dataDirty = true
    }
  },
  devStep(e) {
    const from = Math.max(e.after, e.t - 15e3)
    if (e.t - e.after > 60e3) {
      return { skip: 'late' }
    }
    const S = this.samples
    const inW = (a, b) => S.filter(x => x.t >= a && x.t <= b).map(x => x.p)
    const bef = inW(from - 30e3, from)
    const aft = inW(e.t + 3e3, e.t + 30e3)
    if (bef.length < 5 || aft.length < 5) {
      return { skip: 'readings' }
    }
    const busy
      = this.devEvents.some(h => h.id !== e.id && h.t >= from - 30e3 && h.t <= e.t + 30e3)
        || this.meterChanges.some(
          c => c.t >= from - 30e3 && c.t <= e.t + 30e3 && !this.devsOf(this.sigById(c.sid)).includes(e.id),
        )
    if (busy) {
      return { skip: 'busy' }
    }
    const mb = median(bef)
    const ma = median(aft)
    const noise = Math.max(mad(bef), mad(aft))
    const w = e.on
      ? ma - mb
      : mb - ma
    // how jumpy the house may be grows with the change: a 2 kW heater stands out in a house wandering by 100 W, a lamp doesn't
    if (noise > Math.max(40, Math.abs(w) * 0.15)) {
      return { skip: 'noisy' }
    }
    if (w < Math.max(1.5, 3 * noise)) {
      return w < -Math.max(5, 3 * noise)
        ? { skip: 'wrongway' }
        : { small: true }
    }
    return { w }
  },
  estSummary() {
    const out = {}
    for (const [id, x] of Object.entries(this.devEst)) {
      const w = x.ws.length
        ? median(x.ws)
        : null
      out[id] = {
        w: w == null
          ? null
          : Math.round(w * 10) / 10,
        n: x.n,
        used: x.ws.length,
        spread: w
          ? Math.round((mad(x.ws) / w) * 100) / 100
          : null,
        small: x.small || 0,
        skip: x.skip || 0,
        why: x.why || {},
        t: x.t,
      }
    }
    return out
  },
  // ---------- an appliance's devices: one (devId), or several combined (devId + alsoDevs: two lamps as "Study lights") ----------
  devsOf(s) {
    return s?.devId
      ? [
          s.devId,
          ...(Array.isArray(s.alsoDevs)
            ? s.alsoDevs
            : []),
        ]
      : []
  },
  trackedBy(devId) {
    return this.sigs.find(s => this.devsOf(s).includes(devId)) || null
  },
  // what one switch-only device draws when on: the typed watts (shared between the appliance's switch-only devices) or its learned figure
  estFor(s, id) {
    const sw = this.devsOf(s).filter(x => typeof this.device(x)?.values?.Watts !== 'number').length || 1
    if (s.estW > 0) {
      return s.estW / sw
    }
    const x = this.devEst[id]
    return x?.ws.length
      ? median(x.ws)
      : 0
  },
  /** The appliance's reading from all its devices: watts added up (measured, or learned per switch when on); on if any is on. */
  combined(s) {
    const parts = this.devsOf(s)
      .map(id => this.device(id))
      .filter(Boolean)
    if (!parts.length) {
      return null
    }
    let w = 0
    let measured = false
    const ons = parts.filter(a => typeof a.on === 'boolean')
    for (const a of parts) {
      if (typeof a.values?.Watts === 'number') {
        w += a.values.Watts
        measured = true
      } else if (a.on === true) {
        w += this.estFor(s, a.id)
      }
    }
    return {
      w,
      measured,
      on: ons.length
        ? ons.some(a => a.on)
        : undefined,
    }
  },
  devReading(s, t) {
    const r = this.combined(s)
    if (!r) {
      return
    }
    if (!s.estimated && r.measured) {
      this.meterReading(s, r.w, r.on, t)
    } else if (s.estimated && r.on !== undefined) {
      this.meterReading(s, r.w, r.on, t)
    }
  },
  estWatts(s) {
    if (s.estW > 0) {
      return s.estW
    }
    return this.devsOf(s).reduce((a, id) => a + this.estFor(s, id), 0)
  },
  estReset(id) {
    delete this.devEst[id]
    this.dirty = true
  },
  // every 10 s: keep estimated appliances' readings (on/off × watts) fresh when nothing has changed for a while
  devTick(t) {
    for (const s of this.sigs) {
      if (s.estimated && s.devId) {
        this.devReading(s, t)
      }
    }
  },
  // Track as appliance: a device with its own watts becomes a measured appliance; an on/off one uses its estimate or typed watts.
  // An appliance already named like the device is upgraded in place, keeping its history.
  // sigId: measure that appliance with the device (Appliances → Edit → Measure it with a device), whatever the names are
  track(devId, watts = null, sigId = null) {
    watts = watts == null || watts === ''
      ? null
      : Math.round(+watts * 10) / 10
    if (watts != null && !(watts > 0 && watts < 20000)) {
      throw new Error('Watts must be between 0 and 20,000.')
    }
    const a = this.device(devId)
    if (!a) {
      throw new Error('That device isn\'t connected right now, so it can\'t be tracked yet.')
    }
    if (isSensor(a)) {
      throw new Error(`"${a.name}" is a sensor, not something that uses power.`)
    }
    const estimated = typeof a.values?.Watts !== 'number'
    if (estimated && typeof a.on !== 'boolean') {
      throw new Error(`"${a.name}" doesn't report its own power or switch on and off.`)
    }
    if (estimated && !(watts > 0) && !this.devEst[devId]?.ws.length) {
      throw new Error(
        `No estimate for "${a.name}" yet: switch it on and off a few times while little else is changing, or type its watts.`,
      )
    }
    if (this.trackedBy(devId)) {
      throw new Error(`"${a.name}" is tracked already.`)
    }
    let s = sigId
      ? this.sigById(sigId)
      : this.sigs.find(x => x.name.trim().toLowerCase() === a.name.trim().toLowerCase() && !x.devId)
    if (sigId && !s) {
      throw new Error('Unknown appliance')
    }
    if (sigId && s.devId) {
      return this.combine(sigId, devId, watts)
    } // it has a device already: this one joins it
    if (s) {
      delete s.relink
      s.metered = true
      s.devId = devId
      s.recentRuns = []
      delete s.learn
      delete s.cycles
      delete s.progs
      delete this.running[s.id]
      delete this.activeStages[s.id]
      delete this.meterRun[s.id]
    } else {
      if (this.sigs.length >= MAX_SIGS) {
        throw new Error(`Up to ${MAX_SIGS} appliances.`)
      }
      s = this.newSig(a.name, { exposed: false, metered: true, devId }) // in Apple Home already: no extra outlet by default
    }
    if (estimated) {
      s.estimated = true
      if (watts) {
        s.estW = watts
      } else {
        delete s.estW
      }
    } else {
      delete s.estimated
      delete s.estW
    }
    const room = this.settings.devRooms[devId]
    if (room && !s.room) {
      s.room = room
      this.noteRoom(room)
    }
    delete this.settings.devRooms[devId]
    this.changed()
    this.emit('sigs')
    return s
  },
  /**
   * Add a device to an appliance that already has one, so they count as one (two lamps as "Study lights"): their watts are
   * added up, it's running while any of them is on, and it's one outlet in Apple Home. What it learned about runs starts again.
   */
  combine(id, devId, watts = null) {
    const s = this.sigById(id)
    if (!s?.devId) {
      throw new Error('Link that appliance to its first device before adding another.')
    }
    const a = this.device(devId)
    if (!a) {
      throw new Error('That device isn\'t connected right now, so it can\'t be added yet.')
    }
    if (isSensor(a)) {
      throw new Error(`"${a.name}" is a sensor, not something that uses power.`)
    }
    const t = this.trackedBy(devId)
    if (t) {
      throw new Error(
        t === s
          ? `"${a.name}" is part of "${s.name}" already.`
          : `"${a.name}" is tracked as "${t.name}" already. Stop tracking it there first.`,
      )
    }
    if (this.devsOf(s).length >= 8) {
      throw new Error('Up to 8 devices in one appliance.')
    }
    const switchOnly = typeof a.values?.Watts !== 'number'
    if (switchOnly && typeof a.on !== 'boolean') {
      throw new Error(`"${a.name}" doesn't report its own power or switch on and off.`)
    }
    const learned = this.devEst[devId]?.ws.length
      ? median(this.devEst[devId].ws)
      : 0
    const typed = watts > 0
      ? +watts
      : 0
    if (switchOnly && !learned && !(s.estimated && typed)) {
      throw new Error(
        `No watts learned for "${a.name}" yet: switch it on and off a few times while little else is changing${s.estimated ? ', or type its watts' : ''}, then add it.`,
      )
    }
    // switch-only appliance with typed watts (the total with all of them on), or this one's watts typed: the total grows by it
    if (switchOnly && s.estimated && (s.estW > 0 || typed)) {
      s.estW = Math.round(((s.estW > 0
        ? s.estW
        : this.estWatts(s)) + (typed || learned)) * 10) / 10
    }
    s.alsoDevs = [
      ...(s.alsoDevs || []),
      devId,
    ]
    if (!switchOnly) {
      delete s.estimated
      delete s.estW
    } // one that measures: the appliance is measured (switch-only ones add their learned watts)
    this.restartLearning(s)
    this.changed()
    this.emit('sigs')
    return s
  },
  /** Take one device out of a combined appliance (the others stay). */
  separate(id, devId) {
    const s = this.sigById(id)
    const devs = this.devsOf(s)
    if (!devs.includes(devId)) {
      throw new Error('That device isn\'t part of this appliance.')
    }
    if (devs.length === 1) {
      return this.untrack(id)
    }
    const rest = devs.filter(x => x !== devId)
    s.devId = rest[0]
    if (rest.length > 1) {
      s.alsoDevs = rest.slice(1)
    } else {
      delete s.alsoDevs
    }
    const measured = rest.some(x => typeof this.device(x)?.values?.Watts === 'number')
    if (!measured && rest.every(x => typeof this.device(x)?.on === 'boolean')) {
      s.estimated = true
    }
    this.restartLearning(s)
    this.changed()
    this.emit('sigs')
    return s
  },
  // its devices changed: what was learned about its runs, cycles and levels came from the old set, so it starts again
  restartLearning(s) {
    s.recentRuns = []
    delete s.learn
    delete s.cycles
    delete s.progs
    for (const k of [
      this.running,
      this.activeStages,
      this.meterRun,
      this.meter,
    ]) delete k[s.id]
  },
  setEstWatts(id, watts) {
    const s = this.sigs.find(x => x.id === id && x.estimated)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    if (watts == null || watts === '') {
      delete s.estW
    } else {
      const w = Math.round(+watts * 10) / 10
      if (!(w > 0 && w < 20000)) {
        throw new Error('Watts must be between 0 and 20,000.')
      }
      s.estW = w
    }
    this.changed()
  },
  // Stop tracking: the appliance stays (with its history) and is recognised from whole-house steps again
  untrack(id) {
    const s = this.sigs.find(x => x.id === id && x.devId)
    if (!s) {
      throw new Error('That appliance isn\'t tracked by a device.')
    }
    delete s.devId
    delete s.alsoDevs
    delete s.estimated
    delete s.estW
    delete s.relink
    s.metered = false
    delete this.meter[id]
    delete this.meterRun[id]
    delete this.running[id]
    s.recentRuns = []
    delete s.cycles
    delete s.progs // measured lengths and patterns don't carry over to steps: it starts again
    this.changed()
    this.emit('sigs')
  },
  // an appliance measured through another Homebridge plugin before ("relink"): keep it recognised from whole-house steps, and stop asking
  keepSteps(id) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    delete s.relink
    this.changed()
  },
  // ---------- Matter devices (paired as a second controller; lib/matter-devices.js) ----------
  addMatter({ name }) {
    if (this.matterDevices.length >= MAX_MATTER) {
      throw new Error(`Up to ${MAX_MATTER} Matter devices.`)
    }
    const m = {
      id: `mtr-${uid()}`,
      name: clean(name, 40) || 'Matter device',
      nodeId: null,
      status: 'pairing',
      error: null,
      product: '',
    }
    this.matterDevices.push(m)
    this.changed()
    return m
  },
  matterById(id) {
    return this.matterDevices.find(m => m.id === id)
  },
  matterByNode(nodeId) {
    return this.matterDevices.find(m => m.nodeId === String(nodeId))
  },
  matterPairing(id) {
    const m = this.matterById(id)
    if (!m) {
      throw new Error('Unknown Matter device')
    }
    m.status = 'pairing'
    m.error = null
    this.changed()
    return m
  },
  matterPaired(id, nodeId) {
    const m = this.matterById(id)
    if (!m) {
      return
    }
    m.nodeId = String(nodeId)
    m.status = 'connecting'
    m.error = null
    this.changed()
  },
  matterFailed(id, error) {
    const m = this.matterById(id)
    if (!m) {
      return
    }
    m.status = 'failed'
    m.error = String(error || 'Failed').slice(0, 300)
    this.changed()
  },
  matterStatus(nodeId, state) {
    const m = this.matterByNode(nodeId)
    if (!m) {
      return
    }
    const st = /^connected$/i.test(state)
      ? 'connected'
      : /reconnect|discover|waiting/i.test(state)
        ? 'reconnecting'
        : /disconnect/i.test(state)
          ? 'offline'
          : m.status
    if (st !== m.status) {
      m.status = st
      this.dataChanged()
      this.matterPublish()
    }
  },
  matterInfo(nodeId, product, devices) {
    const m = this.matterByNode(nodeId)
    if (!m) {
      return
    }
    m.product = clean(product, 60)
    m.status = 'connected'
    m.error = null
    const old = this.matterState[m.nodeId]?.devices || {}
    const nd = {}
    for (const d of (devices || []).slice(0, 200)) {
      nd[d.endpoint] = {
        name: clean(d.name, 80),
        types: d.types || [],
        clusters: d.clusters || [],
        values: old[d.endpoint]?.values || {},
      }
    }
    this.matterState[m.nodeId] = { devices: nd }
    this.changed()
    this.matterPublish()
  },
  matterValue(nodeId, endpoint, key, value) {
    const d = this.matterState[String(nodeId)]?.devices?.[endpoint]
    if (!d || d.values[key] === value) {
      return
    }
    d.values[key] = value
    this.matterPublish()
  },
  removeMatter(id) {
    const m = this.matterById(id)
    if (!m) {
      return null
    }
    this.matterDevices = this.matterDevices.filter(x => x !== m)
    if (m.nodeId) {
      delete this.matterState[m.nodeId]
    }
    this.changed()
    this.matterPublish()
    return m
  },
  matterPublish() {
    this.setSource('matter', this.matterList())
  },
  /** Each Matter device endpoint as a device: id mhub:<node>:<endpoint>. */
  matterList() {
    const out = []
    for (const m of this.matterDevices) {
      const st = m.nodeId && this.matterState[m.nodeId]
      if (!st) {
        continue
      }
      let parts = Object.entries(st.devices)
      // A plug that reports its relay on one endpoint and its power meter on another (IKEA GRILLPLATS: relay on 1, meter on 2)
      // is one socket: shown as one device with both, under the meter's id.
      const relayOnly = parts.filter(([, d]) => d.clusters.includes(0x0006) && !d.clusters.includes(0x0090))
      const meterOnly = parts.filter(([, d]) => d.clusters.includes(0x0090) && !d.clusters.includes(0x0006))
      if (parts.length === 2 && relayOnly.length === 1 && meterOnly.length === 1) {
        const [[, r], [mep, md]] = [relayOnly[0], meterOnly[0]]
        parts = [
          [
            mep,
            {
              name: md.name || r.name,
              types: [
                ...new Set([
                  ...r.types,
                  ...md.types,
                ]),
              ],
              clusters: [
                ...new Set([
                  ...r.clusters,
                  ...md.clusters,
                ]),
              ],
              values: {
                ...md.values,
                on: r.values.on,
                reachable: r.values.reachable === false || md.values.reachable === false
                  ? false
                  : undefined,
              },
            },
          ],
        ]
      }
      const many = parts.length > 1
      for (const [ep, d] of parts) {
        const v = d.values
        const t = new Set(d.types)
        const c = new Set(d.clusters)
        const values = {}
        let type = 'Sensor'
        let on
        if (c.has(0x0045)) {
          type = t.has(0x0043) || t.has(0x0041) || t.has(0x0044)
            ? 'LeakSensor'
            : 'ContactSensor'
        }
        if (c.has(0x0406) && type === 'Sensor') {
          type = 'MotionSensor'
        }
        if (c.has(0x0402) && type === 'Sensor') {
          type = 'TemperatureSensor'
        }
        if (c.has(0x0405) && type === 'Sensor') {
          type = 'HumiditySensor'
        }
        if (c.has(0x0006)) {
          if (typeof v.on === 'boolean') {
            values.On = v.on
            on = v.on
          }
          if (type === 'Sensor') {
            type
              = t.has(0x010A) || t.has(0x010B) || c.has(0x0090)
                ? 'Outlet'
                : c.has(0x0008) || [0x0100, 0x0101, 0x010C, 0x010D].some(x => t.has(x))
                  ? 'Lightbulb'
                  : 'Switch'
          }
        }
        if (c.has(0x0102)) {
          type = 'WindowCovering'
        }
        if (c.has(0x0201)) {
          type = 'Thermostat'
        }
        if (c.has(0x0101)) {
          type = 'LockMechanism'
        }
        if (c.has(0x0090)) {
          if (type === 'Sensor') {
            type = 'PowerMeter'
          }
          if (typeof v.watts === 'number') {
            values.Watts = v.watts
          }
        }
        if (c.has(0x0400) && type === 'Sensor') {
          type = 'LightSensor'
        }
        if (typeof v.temp === 'number') {
          values.Temperature = v.temp
        }
        if (typeof v.hum === 'number') {
          values.Humidity = v.hum
        }
        out.push({
          id: `mhub:${m.nodeId}:${ep}`,
          name: d.name || (many
            ? `${m.name} ${ep}`
            : m.name),
          type,
          values,
          on,
          protocol: 'matter',
          source: m.id,
          reachable: v.reachable === false
            ? false
            : m.status === 'connected',
          model: m.product,
        })
      }
    }
    return out
  },
}
