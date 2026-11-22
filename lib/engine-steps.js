import { clean, MAX_EVENTS, MAX_SIGS, RECENT_RUNS, sameName, VARIABLE_NAMES, W } from './engine-shared.js'
// The engine's whole-house steps: detecting them, telling what they are (size, power factor, start spike, habits), matching
// them to appliances (two at once, variable loads, stages), naming steps, and sharing the house's watts between appliances.
// Installed on Engine.prototype by lib/engine.js, so `this` is the engine.
import { cleanIcon, mad, median, tolFor, uid } from './engine-util.js'
import { clusters, loadKind, stepKind, suggestFor } from './patterns.js'

export const stepMethods = {
  // Split the measured total: measured appliances get their own reading first, learned ones their learned draw, the rest is "Other"
  allocate(p) {
    const per = {}
    const pos = Math.max(p, 0)
    let onMains = 0
    let offMains = 0
    for (const s of this.sigs) {
      if (s.metered) {
        const w = this.meterNow(s.id)
        if (w <= 0) {
          continue
        }
        per[s.id] = w
        if (s.offMains) {
          offMains += w
        } else {
          onMains += w
        }
      }
    }
    const rest = Math.max(0, pos - onMains)
    const step = {}
    const vary = []
    let sum = 0
    for (const id of Object.keys(this.running)) {
      const s = this.sigById(id)
      if (!s || s.metered) {
        continue
      }
      if (s.variable) {
        vary.push(s)
        continue
      }
      const w = this.curTotalWatts(s)
      step[id] = w
      sum += w
    }
    const scale = sum > rest && sum > 0
      ? rest / sum
      : 1
    for (const id in step) per[id] = step[id] * scale
    let other = Math.max(0, rest - sum * scale)
    // a load that varies (a heat pump, an EV charger): whatever is left above what "Other" was when it started is its
    if (vary.length) {
      const base = Math.max(...vary.map(s => this.varBase[s.id] ?? 0))
      const free = Math.max(0, other - base)
      const tw = vary.reduce((a, s) => a + (s.watts || 1), 0)
      for (const s of vary) per[s.id] = (free * (s.watts || 1)) / tw
      other -= free
    }
    return { per, other, offMains }
  },
  // a variable load's own share now, from the latest reading
  varShare(s, p = this.samples.at(-1)?.p ?? 0) {
    return this.allocate(p).per[s.id] || 0
  },
  // a "running" learned appliance must have stopped if the house draws clearly less than it needs for 30 s
  checkImpossible(t, p) {
    for (const id of Object.keys(this.running)) {
      const s = this.sigById(id)
      if (!s) {
        delete this.running[id]
        continue
      }
      if (s.metered) {
        continue
      }
      // a variable load is finished once its share has stayed near nothing for 10 minutes (its off step was missed)
      if (s.variable) {
        if (this.varShare(s, p) < Math.max(20, s.watts * 0.1)) {
          this.varLow[id] = (this.varLow[id] || 0) + 1
        } else {
          delete this.varLow[id]
        }
        if (this.varLow[id] >= 600) {
          delete this.varLow[id]
          this.endVariable(s, t)
        }
        continue
      }
      const w = this.curTotalWatts(s)
      if (p < w - tolFor(w)) {
        this.impossible[id] = (this.impossible[id] || 0) + 1
      } else {
        delete this.impossible[id]
      }
      if (this.impossible[id] >= 30) {
        const dur = (t - this.running[id]) / 1000
        s.runs = (s.runs || 0) + 1
        s.totalSec = (s.totalSec || 0) + dur
        s.oddEnds = (s.oddEnds || 0) + 1 // a run that ended without a matching step: a sign it varies its power
        delete this.running[id]
        delete this.impossible[id]
        delete this.activeStages[id]
        this.lastOffAt[id] = t
        this.dataChanged()
        this.emit('finished', s, dur)
      }
    }
  },
  endVariable(s, t) {
    const dur = (t - this.running[s.id]) / 1000
    s.runs = (s.runs || 0) + 1
    s.totalSec = (s.totalSec || 0) + dur
    delete this.running[s.id]
    delete this.activeStages[s.id]
    delete this.varBase[s.id]
    delete this.varLow[s.id]
    this.lastOffAt[s.id] = t
    this.recordRun(s, dur)
    this.dataChanged()
    this.emit('finished', s, dur)
  },
  // ---------- step detection ----------
  detect(t) {
    const n = this.samples.length
    if (n < 2 * W) {
      return
    }
    const P = (a, b) => this.samples.slice(a, b).map(s => s.p)
    const range = a => Math.max(...a) - Math.min(...a)
    const loose = d => Math.max(20, Math.abs(d) * 0.25)
    const after = P(n - W, n)
    // the level it stepped from: the window just before, or, when that's still moving (a motor's start spike, a ramp), the last
    // steady window up to 8 readings further back
    let ref = n - W
    let d = median(after) - median(P(ref - W, ref))
    if (range(P(ref - W, ref)) > loose(d)) {
      ref = null
      for (let end = n - W - 1; end >= Math.max(W, n - W - 8); end--) {
        const win = P(end - W, end)
        const dd = median(after) - median(win)
        if (range(win) <= loose(dd)) {
          ref = end
          d = dd
          break
        }
      }
      if (ref == null) {
        return
      }
    }
    if (Math.abs(d) < this.settings.threshold) {
      return
    }
    if (range(after) > loose(d)) {
      return
    } // still settling
    if (t - this.lastEventT < 2 * W * 1000) {
      return
    }
    this.lastEventT = t
    this.handleEvent(this.samples[ref].t, d, this.stepSignature(ref, n, d))
  },
  /**
   * What else the meter says about a step, beyond its size: its power factor (from the change in real and reactive power; about
   * 1 for heaters and kettles, lower for motors and compressors) and, switching on, its start spike (the highest reading around
   * the step against where it settled; motors and compressors jump well past it for a moment). Either is null when unknown.
   */
  stepSignature(ref, n, d) {
    const S = this.samples
    const bq = S.slice(ref - W, ref)
      .map(s => s.q)
      .filter(q => q != null)
    const aq = S.slice(n - W, n)
      .map(s => s.q)
      .filter(q => q != null)
    let pf = null
    if (bq.length >= 2 && aq.length >= 2) {
      const dq = median(aq) - median(bq)
      pf = Math.round((Math.abs(d) / Math.hypot(d, dq)) * 100) / 100
    }
    let spike = null
    if (d > 0) {
      const pre = median(S.slice(ref - W, ref).map(s => s.p))
      const peak = Math.max(...S.slice(ref, n).map(s => s.p))
      spike = Math.round(((peak - pre) / d) * 100) / 100
    }
    return { pf, spike }
  },
  // an appliance's own signature from its steps: median power factor and start spike, with how many steps they come from
  signatureOf(s) {
    const key = `${this.version}|${this.events.length}`
    if (this.sigCache?.key !== key) {
      this.sigCache = {
        key,
        m: new Map(),
      }
    }
    let v = this.sigCache.m.get(s.id)
    if (!v) {
      const on = this.events.filter(
        e => e.sig === s.id && e.dir === 'on' && !e.stage && !e.metered && !e.also && !e.withStage && !e.vary,
      )
      const pfs = on.map(e => e.pf).filter(x => x != null)
      const sp = on.map(e => e.spike).filter(x => x != null)
      v = {
        pf: pfs.length >= 3
          ? median(pfs)
          : null,
        spike: sp.length >= 3
          ? median(sp)
          : null,
        n: pfs.length,
        kind: loadKind(on),
      }
      this.sigCache.m.set(s.id, v)
    }
    return v
  },
  // the appliance a step belongs to: the closest in size; when its power factor is known, not one whose power factor is clearly
  // different (a heater and a pump of the same size), and between two close in size the one whose power factor fits better
  matchSig(w, onlyRunning, f = {}, t = Date.now()) {
    let best = null
    let be = Infinity
    for (const s of this.sigs) {
      if (s.metered || !s.watts) {
        continue
      }
      if (onlyRunning && !this.running[s.id]) {
        continue
      }
      if (s.variable && this.running[s.id]) {
        continue
      } // its steps while it runs are matchVariable's
      let e = Math.abs(w - s.watts)
      if (!(e < tolFor(s.watts) * (onlyRunning ? 1.4 : 1))) {
        continue
      }
      if (!onlyRunning && (f.pf != null || f.spike != null)) {
        const g = this.signatureOf(s)
        const k = stepKind(f)
        const gk = g.kind
        if (k && gk && k !== gk) {
          continue
        } // a motor-like step isn't a heater, and the other way round
        if (g.pf != null && f.pf != null) {
          if (Math.abs(g.pf - f.pf) > 0.15) {
            continue
          }
          e += Math.abs(g.pf - f.pf) * tolFor(s.watts) * 2
        }
      }
      // habits break near ties: a switch-on at an hour it usually starts, a switch-off after about as long as it usually runs
      e *= onlyRunning
        ? this.lengthFactor(s, t)
        : this.hourFactor(s, t)
      if (e < be) {
        be = e
        best = s
      }
    }
    return best
  },
  // how sure its figures are: 'exact' (its own device measures it), 'good', or 'unsure', with the reason in words
  confidence(s) {
    if (s.metered) {
      return s.estimated
        ? { level: 'good', why: 'Its device says when it is on; its watts are learned or typed, not measured.' }
        : { level: 'exact', why: 'Measured by its own device.' }
    }
    const on = this.events
      .filter(e => e.sig === s.id && e.dir === 'on' && !e.stage && !e.also && !e.withStage && !e.vary && !e.metered)
      .map(e => Math.abs(e.d))
    const runs = Math.max(s.runs || 0, on.length)
    const kind = this.signatureOf(s).kind
    const near = this.sigs.filter(
      x => x !== s && !x.metered && x.watts && Math.abs(x.watts - s.watts) < tolFor(Math.max(x.watts, s.watts)),
    )
    const apart = near.filter(x => kind && this.signatureOf(x).kind && this.signatureOf(x).kind !== kind)
    const same = near.filter(x => !apart.includes(x))
    const spread = on.length >= 3
      ? mad(on) / (median(on) || 1)
      : 0
    if (runs < 3) {
      return {
        level: 'unsure',
        why: `Only ${runs === 1
          ? 'one run'
          : `${runs} runs`} so far: it gets surer as it sees more.`,
      }
    }
    if (same.length) {
      return {
        level: 'unsure',
        why: `About the same size as ${same
          .slice(0, 2)
          .map(x => `"${x.name}"`)
          .join(
            ' and ',
          )}, so their steps can be mixed up.${kind ? '' : ' A meter that reports power factor would help tell them apart.'}`,
      }
    }
    if (spread > 0.1) {
      return { level: 'unsure', why: 'Its switch-ons vary in size, so some may be something else.' }
    }
    const extra = [
      apart.length
        ? `told apart from ${apart
          .slice(0, 2)
          .map(x => `"${x.name}"`)
          .join(' and ')} by how it draws power`
        : '',
      s.variable ? 'it varies, so its share of the house is worked out' : '',
    ].filter(Boolean)
    return {
      level: 'good',
      why: `its switch-ons are all about the same size${extra.length
        ? `; ${extra.join('; ')}`
        : ''}.`.replace(
        /^./,
        c => c.toUpperCase(),
      ),
    }
  },
  // 0.6 (it usually starts at this hour) to 1 (never has, or not enough known): from the hours of its last starts
  hourFactor(s, t) {
    const H = s.hours
    if (!H) {
      return 1
    }
    const n = H.reduce((a, b) => a + b, 0)
    if (n < 5) {
      return 1
    }
    const h = new Date(t).getHours()
    const near = H[h] + 0.5 * (H[(h + 23) % 24] + H[(h + 1) % 24])
    return 1 - 0.4 * Math.min(1, (near / n) * 3)
  },
  // 1 (as long as its usual runs) to 2 (three times longer or shorter): from its recent run lengths, once it has three
  lengthFactor(s, t) {
    const R = s.recentRuns
    if (!R || R.length < 3 || !this.running[s.id]) {
      return 1
    }
    const dur = (t - this.running[s.id]) / 1000
    const m = median(R)
    if (!(m > 0) || !(dur > 0)) {
      return 1
    }
    return 1 + Math.min(1, Math.abs(Math.log(dur / m)) / Math.log(3))
  },
  noteStart(s, t) {
    const H = (s.hours ??= Array.from({ length: 24 }).fill(0))
    H[new Date(t).getHours()]++
    if (H.reduce((a, b) => a + b, 0) > 200) {
      for (let i = 0; i < 24; i++) H[i] = H[i] / 2
    } // recent habits count more
  },
  // a running variable load: a step down that leaves it next to nothing is its switch-off; any other step it can explain (down,
  // or up by no more than its usual size) is it turning itself up or down. A step that matches a fixed appliance goes to that.
  matchVariable(w, dir, fixed) {
    for (const s of this.sigs) {
      if (!s.variable || s.metered || !this.running[s.id]) {
        continue
      }
      if (dir === 'off') {
        const left = this.varShare(s)
        if (left < Math.max(30, s.watts * 0.2) && w >= s.watts * 0.3) {
          return { sig: s, end: true }
        }
        if (!fixed || !this.running[fixed.id]) {
          // a switch-off the size of a step up earlier in this run: that was something else switched on and off (a kettle while the
          // heat pump runs), not the heat pump turning itself up. Both go back to unclaimed, so it's found and can be named.
          const pulse = this.events.find(
            e =>
              e.dir === 'on'
              && e.t >= this.running[s.id]
              && (e.vary
                ? e.sig === s.id
                : !e.sig)
              && Math.abs(e.d - w) < tolFor(w),
          )
          if (pulse) {
            return { sig: s, pulse }
          }
          if (left >= Math.max(30, s.watts * 0.2)) {
            return { sig: s }
          }
        }
      } else if (!fixed && w <= Math.max(s.watts, 200)) {
        return { sig: s }
      }
    }
    return null
  },
  // a switch-on the size of two known things together. Only when one answer is clearly best: a near tie between two answers
  // leaves the step unclaimed rather than guessing.
  matchOnPair(w, f = {}) {
    const k = stepKind(f)
    const fits = s => !k || !this.signatureOf(s).kind || this.signatureOf(s).kind === k || !f.pf
    const idle = this.sigs.filter(s => !s.metered && s.watts && !this.running[s.id])
    const opts = []
    for (let i = 0; i < idle.length; i++) {
      for (let j = i + 1; j < idle.length; j++) {
        const sum = idle[i].watts + idle[j].watts
        opts.push({
          e: Math.abs(w - sum),
          tol: tolFor(sum),
          pair: [idle[i], idle[j]],
        })
      }
      for (const st of idle[i].stages || []) {
        const sum = idle[i].watts + st.watts
        opts.push({
          e: Math.abs(w - sum),
          tol: tolFor(sum),
          sig: idle[i],
          stage: st,
        })
      }
    }
    const ok = opts
      .filter(o => o.e < o.tol * 0.7 && (o.pair
        ? o.pair.some(fits)
        : fits(o.sig)))
      .sort((a, b) => a.e - b.e)
    if (!ok.length || (ok[1] && ok[1].e - ok[0].e < ok[0].tol * 0.3)) {
      return null
    }
    return ok[0]
  },
  matchPair(w) {
    const on = this.sigs.filter(s => this.running[s.id] && !s.metered)
    let best = null
    let be = Infinity
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        const sum = on[i].watts + on[j].watts
        const e = Math.abs(w - sum)
        if (e < tolFor(sum) && e < be) {
          be = e
          best = [on[i], on[j]]
        }
      }
    }
    return best
  },
  // base draw plus whichever of its learned extra stages (a dryer's heating element…) are on in this run
  curTotalWatts(s) {
    const active = this.activeStages[s.id]
    if (!active?.length || !s.stages?.length) {
      return s.watts
    }
    return s.watts + active.reduce((sum, id) => sum + (s.stages.find(x => x.id === id)?.watts || 0), 0)
  },
  // a step that is a known extra level of something already running, before treating it as a new appliance
  matchRunningLevel(w, dir) {
    let best = null
    let be = Infinity
    if (dir === 'on') {
      for (const s of this.sigs) {
        if (s.metered || !this.running[s.id] || !s.stages?.length) {
          continue
        }
        const active = this.activeStages[s.id] || []
        for (const st of s.stages) {
          if (active.includes(st.id)) {
            continue
          }
          const e = Math.abs(st.watts - w)
          if (e < tolFor(st.watts) && e < be) {
            be = e
            best = { kind: 'stageUp', sig: s, stage: st }
          }
        }
      }
      return best
    }
    for (const s of this.sigs) {
      if (s.metered || !this.running[s.id]) {
        continue
      }
      const active = this.activeStages[s.id]
      if (!active?.length) {
        continue
      }
      const total = this.curTotalWatts(s)
      const eTotal = Math.abs(total - w)
      if (eTotal < tolFor(total) && eTotal < be) {
        be = eTotal
        best = { kind: 'fullStop', sig: s }
      }
      for (const id of active) {
        const st = s.stages.find(x => x.id === id)
        if (!st) {
          continue
        }
        const e = Math.abs(st.watts - w)
        if (e < tolFor(st.watts) && e < be) {
          be = e
          best = { kind: 'stageDown', sig: s, stage: st }
        }
      }
    }
    return best
  },
  applyStage(ev, m) {
    const { kind, sig: s, stage } = m
    ev.sig = s.id
    s.lastSeen = ev.t
    if (kind === 'fullStop') {
      this.applyMatch(ev, s)
      delete this.activeStages[s.id]
      return
    }
    ev.stage = stage.id
    const active = (this.activeStages[s.id] ??= [])
    if (kind === 'stageUp') {
      active.push(stage.id)
      ev.stageOn = true
    } else {
      const i = active.indexOf(stage.id)
      if (i >= 0) {
        active.splice(i, 1)
      }
      ev.stageOn = false
    }
  },
  applyMatch(ev, s) {
    ev.sig = s.id
    s.lastSeen = ev.t
    if (ev.dir === 'on') {
      this.running[s.id] = ev.t
      this.noteStart(s, ev.t)
    } else if (this.running[s.id]) {
      const dur = (ev.t - this.running[s.id]) / 1000
      ev.dur = dur
      s.runs = (s.runs || 0) + 1
      s.totalSec = (s.totalSec || 0) + dur
      delete this.running[s.id]
      delete this.activeStages[s.id]
      this.lastOffAt[s.id] = ev.t
      ev.counted = true
      this.recordRun(s, dur)
      this.emit('finished', s, dur)
    }
  },
  // a finished run joins the appliance's recent runs (its usual length, for "running long" and the time left)
  recordRun(s, dur) {
    if (dur > 0) {
      s.recentRuns = [
        ...(s.recentRuns || []),
        dur,
      ].slice(-RECENT_RUNS)
    }
  },
  handleEvent(t, d, f = {}) {
    const w = Math.abs(d)
    const dir = d > 0
      ? 'on'
      : 'off'
    const ev = {
      id: uid(),
      t,
      d: Math.round(d),
      dir,
      sig: null,
      ...(f.pf != null
        ? { pf: f.pf }
        : {}),
      ...(f.spike != null
        ? { spike: f.spike }
        : {}),
    }
    const meterSig = this.matchMeterChange(t, d)
    const stageMatch = meterSig
      ? null
      : this.matchRunningLevel(w, dir)
    const s
      = meterSig || stageMatch
        ? null
        : dir === 'off'
          ? this.matchSig(w, true, {}, t) || this.matchSig(w, false, f, t)
          : this.matchSig(w, false, f, t)
    const vary
      = meterSig || stageMatch || (s && this.running[s.id] && dir === 'off')
        ? null
        : this.matchVariable(w, dir, s)
    const pNow = this.samples.at(-1)?.p ?? 0
    if (vary?.end) {
      this.applyMatch(ev, vary.sig)
      delete this.varBase[vary.sig.id]
      delete this.varLow[vary.sig.id]
    } else if (vary?.pulse) {
      // something else on and off during its run: both unclaimed
      vary.pulse.sig = null
      delete vary.pulse.vary
    } else if (vary) {
      // it turned itself up or down
      ev.sig = vary.sig.id
      ev.vary = true
      vary.sig.lastSeen = t
    } else if (meterSig) {
      ev.sig = meterSig
      ev.metered = true
    } else if (stageMatch) {
      this.applyStage(ev, stageMatch)
    } else if (s) {
      if (s.variable && dir === 'on') {
        this.varBase[s.id] = this.allocate(pNow - d).other
      }
      this.applyMatch(ev, s)
    } else if (dir === 'off') {
      const pair = this.matchPair(w)
      if (pair) {
        const e2 = { ...ev }
        this.applyMatch(ev, pair[0])
        this.applyMatch(e2, pair[1])
        ev.also = pair[1].id
        ev.dur ??= e2.dur
      }
    } else {
      // two things switched on in the same second: two known appliances, or an appliance and one of its own stages
      const two = this.matchOnPair(w, f)
      if (two?.stage) {
        this.applyMatch(ev, two.sig)
        ;(this.activeStages[two.sig.id] ??= []).push(two.stage.id)
        ev.withStage = two.stage.id
      } else if (two) {
        this.applyMatch(ev, two.pair[0])
        this.applyMatch({ ...ev }, two.pair[1])
        ev.also = two.pair[1].id
      }
    }
    this.events.unshift(ev)
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS
    }
    this.dataChanged()
    this.emit('event', ev, s)
  },
  // ---------- naming steps ----------
  learn(eventIds, name, icon, home = {}) {
    name = clean(name, 60)
    const evs = this.events.filter(e => eventIds.includes(e.id) && !e.metered)
    if (!name || !evs.length) {
      throw new Error('Need a name and at least one power step')
    }
    for (const ev of evs) {
      if (ev.sig) {
        ev.sig = null
        delete ev.dur
      }
    }
    // which appliance: the one asked for (a suggestion's), else the one of this name in this room; with no room given, the only
    // one of this name. Names are unique per room, so "Downlights" can be in the dining room and the hall.
    const room = home.room != null
      ? this.cleanRoom(home.room)
      : null
    const same = this.sigs.filter(x => sameName(x.name, name))
    let s = home.sigId
      ? this.sigById(home.sigId)
      : same.find(x => room != null && (x.room || '') === room) || (!room && same.length === 1
        ? same[0]
        : null)
    if (home.sigId && !s) {
      throw new Error('Unknown appliance')
    }
    if (s?.metered) {
      // steps from before its device was tracked: just credit them to it (its watts come from the device)
      for (const ev of evs) {
        ev.sig = s.id
        ev.metered = true
      }
      this.changed()
      return s
    }
    if (!s) {
      if (this.sigs.length >= MAX_SIGS) {
        throw new Error(`Up to ${MAX_SIGS} appliances.`)
      }
      s = this.newSig(name, VARIABLE_NAMES.test(name)
        ? { variable: true }
        : {})
    }
    if (cleanIcon(icon)) {
      s.icon = cleanIcon(icon)
    }
    if (home.room != null) {
      s.room = this.cleanRoom(home.room)
      this.noteRoom(s.room)
    }
    for (const ev of evs) ev.sig = s.id
    // rebuild every run of this appliance in order: a second "on" inside an open run is a stage of it, not a new run
    const mine = this.events.filter(e => e.sig === s.id || e.also === s.id).sort((a, b) => a.t - b.t)
    let on = null
    let curW = 0
    let active = []
    let wattsSum = 0
    let wattsN = 0
    const durs = []
    s.runs = 0
    s.totalSec = 0
    s.stages = []
    delete s.hours
    delete this.running[s.id]
    delete this.activeStages[s.id]
    for (const e of mine) {
      if (e.vary) {
        continue
      } // a variable load turning itself up or down: not a switch
      // a step shared with another appliance (both switched together) counts as this one's own usual size
      const shared = e.also != null || e.withStage != null
      const w = shared
        ? s.watts || Math.abs(e.d)
        : Math.abs(e.d)
      if (e.sig === s.id && !e.withStage) {
        delete e.stage
        delete e.stageOn
      }
      if (!on) {
        if (e.dir !== 'off') {
          on = e
          curW = w
          active = []
          if (!shared) {
            wattsSum += w
            wattsN++
          }
          this.noteStart(s, e.t)
          const ws = e.withStage && s.stages.find(x => x.id === e.withStage)
          if (ws) {
            curW += ws.watts
            active.push(ws.id)
          } else if (e.withStage) {
            delete e.withStage
          }
        }
      } else if (e.dir === 'on') {
        let st = s.stages.find(x => Math.abs(x.watts - w) < tolFor(x.watts))
        if (!st) {
          st = {
            id: uid(),
            watts: w,
            count: 0,
          }
          s.stages.push(st)
        }
        st.watts = (st.watts * st.count + w) / (st.count + 1)
        st.count++
        active.push(st.id)
        curW += w
        e.stage = st.id
        e.stageOn = true
      } else if (Math.abs(w - curW) < tolFor(curW) || s.variable) {
        e.dur = (e.t - on.t) / 1000
        s.runs++
        s.totalSec += e.dur
        durs.push(e.dur)
        // runs from before it had a name were counted as "Other": credit them to it in the daily figures
        if (!e.counted) {
          this.creditFromOther(s.id, on.t, e.t, wattsN
            ? wattsSum / wattsN
            : s.watts || Math.abs(on.d))
          e.counted = true
        }
        on = null
        curW = 0
        active = []
      } else {
        const i = active
          .map(id => s.stages.find(x => x.id === id))
          .findIndex(st => st && Math.abs(st.watts - w) < tolFor(st.watts))
        if (i >= 0) {
          curW -= s.stages.find(x => x.id === active[i]).watts
          e.stage = active[i]
          e.stageOn = false
          active.splice(i, 1)
        }
      }
    }
    s.watts = wattsN
      ? wattsSum / wattsN
      : 0
    s.count = wattsN
    s.recentRuns = durs.slice(-RECENT_RUNS) // the runs it already had are its "normal" for spotting unusual ones
    if (on && Date.now() - on.t < 12 * 3600e3 && (!this.now || this.now.p >= curW - tolFor(curW))) {
      this.running[s.id] = on.t
      if (active.length) {
        this.activeStages[s.id] = active
      }
    }
    // other unclaimed steps of its size are its too, unless their kind (heater-like or motor-like) says they're something else
    const kind = loadKind(mine)
    for (const e of this.events) {
      if (
        !e.sig
        && !e.metered
        && s.watts
        && Math.abs(Math.abs(e.d) - s.watts) < tolFor(s.watts)
        && !(kind && stepKind(e) && stepKind(e) !== kind)
      ) {
        e.sig = s.id
      }
    }
    this.settings.dismissed = this.settings.dismissed.filter(x => x.name !== s.name)
    this.changed()
    this.emit('sigs')
    return s
  },
  // a run that happened before the appliance had a name was counted as "Other": move it across in the daily figures, hour by
  // hour, never below 0. The lifetime totals behind the Apple Home tiles (s.kwh, otherKwh) are left alone: they must never go down.
  creditFromOther(id, t0, t1, w) {
    for (let a = t0; a < t1;) {
      const h = new Date(a)
      h.setMinutes(60, 0, 0)
      const b = Math.min(t1, h.getTime())
      const d = this.dayRec(a)
      const hr = new Date(a).getHours()
      const hz = () => Array.from({ length: 24 }).fill(0)
      const want = (w * (b - a)) / 3.6e9
      const oh = (d.oh ??= hz())
      const take = Math.min(want, oh[hr] || 0)
      oh[hr] -= take
      d.other = Math.max(0, (d.other || 0) - take)
      d.apps[id] = (d.apps[id] || 0) + take
      ;((d.ah ??= {})[id] ??= hz())[hr] += take
      a = b
    }
  },
  // name a repeating-step group (from patterns()) in one go
  nameCluster(key, name, icon, home = {}) {
    const c = clusters(this.events).find(x => x.key === key)
    if (!c) {
      throw new Error('Those steps have changed since the page loaded. Reload and try again.')
    }
    return this.learn(
      c.evs.map(e => e.id),
      name,
      icon,
      home,
    )
  },
  dismissSuggestion(name, w) {
    this.settings.dismissed.push({
      name: clean(name, 60),
      w: +w || 0,
    })
    if (this.settings.dismissed.length > 200) {
      this.settings.dismissed.shift()
    }
    this.changed()
  },
  patterns() {
    return clusters(this.events)
      .slice(0, 40)
      .map(c => ({
        key: c.key,
        mean: c.mean,
        n: c.n,
        on: c.on,
        off: c.off,
        last: c.last,
        kind: c.kind,
        suggestion: suggestFor(c, {
          sigs: this.sigs,
          devEvents: this.devEvents,
          dismissed: this.settings.dismissed,
          events: this.events,
          running: this.running,
        }),
      }))
  },
  /**
   * Make two appliances learned from steps one (a spa's pump and heater named separately): the steps of `fromId` join `intoId`
   * (as stages of its runs where they happen inside them), its daily and lifetime energy move across, and it's removed.
   */
  mergeSig(fromId, intoId) {
    const a = this.sigById(fromId)
    const b = this.sigById(intoId)
    if (!a || !b || a === b) {
      throw new Error('Unknown appliance')
    }
    if (a.devId || b.devId) {
      throw new Error(
        'One of these is measured by its own device. To count two devices as one, use "Add another device to it" in its Edit panel instead.',
      )
    }
    const evIds = this.events.filter(e => e.sig === a.id).map(e => e.id)
    for (const d of Object.values(this.energy)) {
      if (d?.apps?.[a.id] != null) {
        d.apps[b.id] = (d.apps[b.id] || 0) + d.apps[a.id]
        delete d.apps[a.id]
      }
      if (d?.ah?.[a.id]) {
        const x = d.ah[b.id] || Array.from({ length: 24 }).fill(0)
        d.ah[b.id] = x.map((v, i) => v + (d.ah[a.id][i] || 0))
        delete d.ah[a.id]
      }
    }
    b.kwh = (b.kwh || 0) + (a.kwh || 0)
    this.sigs = this.sigs.filter(x => x !== a)
    for (const k of [
      this.meter,
      this.meterRun,
      this.running,
      this.activeStages,
      this.lastOffAt,
    ]) delete k[a.id]
    if (evIds.length) {
      this.learn(evIds, b.name, null, { sigId: b.id })
    } // rebuilds its runs: a step inside one of them becomes a stage
    this.changed()
    this.emit('sigs')
    return b
  },
}
