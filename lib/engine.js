// Energy engine: turns the whole-house reading (Shelly EM, every second) into recognised appliances, their runs and
// their energy.
//
// Sources of truth:
//  - whole-house power: processSample() every second
//  - devices this plugin reads itself (Shellys, Matter): setSource() whenever one of them changes
// Appliances ("sigs") are either learned from power steps, or measured ("metered") by a device's own watts, or
// estimated from a device's on/off state and the watts it was seen to switch.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { addRun, matchRun, progStats, removeRun } from './cycles.js'
import {
  cleanIcon,
  dayKey,
  isSensor,
  mad,
  median,
  normIdleMin,
  normStatusCount,
  normStatusType,
  normSteady,
  tolFor,
  uid,
} from './engine-util.js'
import { hostList, lanHost, notLanMessage, rejectedHosts } from './hosts.js'
import { insights } from './insights.js'
import { clusters, suggestFor } from './patterns.js'
import { cleanTariff, costOf, fixedPerDay, hasPlan } from './tariff.js'
import { cleanWeb, webPublic } from './web-auth.js'

const W = 3 // samples per detection window
const SAMPLE_HISTORY = 3600e3 // 1 h of 1-second readings in memory (not saved)
const MINUTE_HISTORY = 7 * 86400e3 // per-minute averages: 7 days
const MAX_EVENTS = 2000
const MAX_DEV_EVENTS = 2000
const MAX_ANOMALIES = 200
const MAX_DAYS = 800
const HOURLY_DAYS = 400
const RECENT_RUNS = 20
const MAX_SIGS = 300
const MAX_MATTER = 100
const STALE_READING = 10 * 60e3 // a measured reading older than this counts as nothing
const SWITCH_WINDOW = { shelly: 4e3, matter: 3e3 } // how long before a change was seen it can have happened (poll gaps)

export { dayKey }
function clean(v, n) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}
function cleanDevEst(v) {
  const out = {}
  if (v && typeof v === 'object') {
    for (const [id, x] of Object.entries(v)) {
      if (id.length <= 200 && x && Array.isArray(x.ws)) {
        out[id] = {
          ws: x.ws.filter(w => Number.isFinite(w) && w > 0).slice(-15),
          n: +x.n || 0,
          skip: +x.skip || 0,
          small: +x.small || 0,
          t: +x.t || 0,
        }
      }
    }
  }
  return out
}
// numbers rounded when saved: 6 decimals keeps kWh to a milliwatt-hour and roughly halves the file
function roundJson(k, v) {
  return typeof v === 'number' && !Number.isInteger(v)
    ? Math.round(v * 1e6) / 1e6
    : v
}

export class Engine extends EventEmitter {
  constructor({ file, defaults = {}, log = console }) {
    super()
    this.file = file
    this.log = log
    this.samples = []
    this.curMin = null
    this.minSum = 0
    this.minN = 0
    this.lastEventT = 0
    this.now = null
    this.version = 1
    this.dirty = false
    this.dataDirty = false
    this.savedAt = 0
    this.sources = {}
    this.devices = []
    this.devById = new Map()
    this.meter = {}
    this.meterRun = {}
    this.meterChanges = []
    this.devPending = []
    this.impossible = {}
    this.matterState = {}
    this.matterSystem = { ok: true, error: null }
    this.load(defaults)
  }

  // ---------- persistence ----------
  load(defaults = {}) {
    let d = {}
    try {
      d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log.warn(
          `Could not read the saved data (${e.message}). Starting fresh; the unreadable file was kept as ${path.basename(this.file)}.bad`,
        )
        try {
          fs.copyFileSync(this.file, `${this.file}.bad`)
        } catch {}
      }
    }
    this.fromData(d, defaults)
  }

  fromData(d, defaults = {}) {
    const S = d.settings || {}
    this.settings = {
      threshold: 40,
      standbyThreshold: 1,
      currency: '$',
      ...defaults,
      ...S,
      em: {
        host: lanHost(S.em?.host ?? defaults.em?.host),
        channel: String(S.em?.channel ?? defaults.em?.channel ?? 'auto').slice(0, 20),
      },
      tariff: cleanTariff(S.tariff || defaults.tariff || {}),
      shellyHosts: hostList(S.shellyHosts),
      other: { on: S.other?.on !== false, name: clean(S.other?.name, 32) || 'Other appliances' },
      cheapTile: S.cheapTile === true,
      dismissed: Array.isArray(S.dismissed)
        ? S.dismissed.filter(x => x && x.name).slice(-200)
        : [],
      rooms: Array.isArray(S.rooms)
        ? S.rooms.map(r => clean(r, 40)).filter(Boolean)
        : [],
      devHidden: Array.isArray(S.devHidden)
        ? S.devHidden
            .map(String)
            .filter(x => x.length <= 200)
            .slice(0, 500)
        : [], // readings hidden from "Found"
      web: cleanWeb(S.web), // the web page: on/off, PIN hash, signed-in browsers (never sent out)
      tipsDismissed:
        S.tipsDismissed && typeof S.tipsDismissed === 'object'
          ? Object.fromEntries(
              Object.entries(S.tipsDismissed)
                .filter(([k, v]) => k.length <= 80 && Number.isFinite(+v))
                .slice(0, 300),
            )
          : {},
    }
    this.sigs = Array.isArray(d.sigs)
      ? d.sigs
      : []
    for (const s of this.sigs) {
      s.stages ??= []
      s.kwh ??= 0
      s.exposed ??= true
      s.statusType = normStatusType(s.statusType, 'none')
      delete s.faucet
      s.statusCount = normStatusCount(s.statusCount)
      s.steadyOutlet = normSteady(s.steadyOutlet)
      s.steadyIdleMin = normIdleMin(s.steadyIdleMin)
    }
    this.events = Array.isArray(d.events)
      ? d.events.slice(0, MAX_EVENTS)
      : []
    this.anomalies = Array.isArray(d.anomalies)
      ? d.anomalies.slice(0, MAX_ANOMALIES)
      : []
    this.minutes = Array.isArray(d.minutes)
      ? d.minutes
      : []
    this.energy = d.energy && typeof d.energy === 'object'
      ? d.energy
      : {}
    this.running = d.running || {}
    this.activeStages = d.activeStages || {}
    this.lastOffAt = d.lastOffAt || {}
    this.otherKwh = +d.otherKwh || 0
    this.lastT = d.lastT || null
    this.devEst = cleanDevEst(d.devEst)
    this.devEvents = Array.isArray(d.devEvents)
      ? d.devEvents.filter(h => h && h.id && typeof h.on === 'boolean').slice(0, MAX_DEV_EVENTS)
      : []
    this.matterDevices = Array.isArray(d.matterDevices)
      ? d.matterDevices.filter(m => m && m.id).slice(0, MAX_MATTER)
      : []
    for (const m of this.matterDevices) {
      if (m.status === 'pairing') {
        m.status = 'failed'
        m.error = 'Pairing was interrupted by a restart. Get a new code from the Home app and try again.'
      }
    }
    this.matterIds = Array.isArray(d.matterIds)
      ? d.matterIds
      : [] // Matter outlets this plugin published (removed when no longer wanted)
    this.hapIds = Array.isArray(d.hapIds)
      ? d.hapIds
      : [] // HAP tiles this plugin published
    this.imported = d.imported || null // { at, from, counts } of the last import
    for (const s of this.sigs) this.noteRoom(s.room)
  }

  toData() {
    return {
      format: 'home-energy-1',
      settings: this.settings,
      sigs: this.sigs,
      events: this.events,
      anomalies: this.anomalies,
      minutes: this.minutes,
      energy: this.energy,
      running: this.running,
      activeStages: this.activeStages,
      lastOffAt: this.lastOffAt,
      otherKwh: this.otherKwh,
      lastT: this.lastT,
      devEst: this.devEst,
      devEvents: this.devEvents,
      matterIds: this.matterIds,
      hapIds: this.hapIds,
      imported: this.imported,
      matterDevices: this.matterDevices.map(({ id, name, nodeId, product, status, error }) => ({
        id,
        name,
        nodeId,
        product,
        status: status === 'pairing'
          ? 'failed'
          : status,
        error,
      })),
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.toData(), roundJson), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      this.dirty = false
      this.dataDirty = false
      this.savedAt = Date.now()
      return true
    } catch (e) {
      this.log.error(`Could not save data: ${e.message}`)
      return false
    }
  }

  // changes to settings and appliances: saved within 30 s. Readings only set dataDirty (saved every 5 minutes).
  changed() {
    this.version++
    this.dirty = true
    this.emit('changed')
  }

  // ---------- rooms ----------
  cleanRoom(r) {
    return clean(r, 40)
  }

  noteRoom(r) {
    if (r && !this.settings.rooms.includes(r)) {
      this.settings.rooms.push(r)
    }
  }

  // ---------- whole-house samples ----------
  dayRec(t) {
    return (this.energy[dayKey(t)] ??= {
      total: 0,
      apps: {},
      other: 0,
      peak: 0,
      peakT: 0,
    })
  }

  meterNow(id) {
    const m = this.meter[id]
    if (!m || Date.now() - m.t > STALE_READING || m.on === false) {
      return 0
    }
    return Math.max(0, m.w)
  }

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
    let sum = 0
    for (const id of Object.keys(this.running)) {
      const s = this.sigById(id)
      if (s && !s.metered) {
        const w = this.curTotalWatts(s)
        step[id] = w
        sum += w
      }
    }
    const scale = sum > rest && sum > 0
      ? rest / sum
      : 1
    for (const id in step) per[id] = step[id] * scale
    return {
      per,
      other: Math.max(0, rest - sum * scale),
      offMains,
    }
  }

  sigById(id) {
    return this.sigs.find(x => x.id === id)
  }

  processSample(t, p) {
    if (!Number.isFinite(p) || (this.lastT && t <= this.lastT)) {
      return
    }
    const d = this.dayRec(t)
    const alloc = this.allocate(p)
    if (this.lastT) {
      const k = Math.min((t - this.lastT) / 1000, 10) / 3.6e6
      const hr = new Date(t).getHours()
      const hz = () => Array.from({ length: 24 }).fill(0)
      const add = (Math.max(p, 0) + alloc.offMains) * k
      d.total += add
      ;(d.h ??= hz())[hr] += add
      d.ah ??= {}
      for (const id in alloc.per) {
        d.apps[id] = (d.apps[id] || 0) + alloc.per[id] * k
        ;(d.ah[id] ??= hz())[hr] += alloc.per[id] * k
        const s = this.sigById(id)
        if (s) {
          s.kwh += alloc.per[id] * k
        }
      }
      d.other = (d.other || 0) + alloc.other * k
      ;(d.oh ??= hz())[hr] += alloc.other * k
      this.otherKwh += alloc.other * k
    }
    if (p > d.peak) {
      d.peak = p
      d.peakT = t
    }
    const prevDay = this.lastT
      ? dayKey(this.lastT)
      : null
    this.lastT = t
    this.samples.push({ t, p: Math.round(p * 10) / 10 })
    while (this.samples.length && this.samples[0].t < t - SAMPLE_HISTORY) this.samples.shift()
    const m = Math.floor(t / 60000)
    if (this.curMin !== null && m !== this.curMin && this.minN) {
      this.minutes.push([this.curMin * 60000, Math.round((this.minSum / this.minN) * 10) / 10])
      this.minSum = 0
      this.minN = 0
      while (this.minutes.length && this.minutes[0][0] < t - MINUTE_HISTORY) this.minutes.shift()
      if (m % 60 === 0) {
        d.base = this.baseLoad(t - 86400e3, t) ?? d.base
      } // always-on, kept with the day
    }
    if (prevDay && prevDay !== dayKey(t)) {
      this.pruneDays()
    }
    this.curMin = m
    this.minSum += p
    this.minN++
    this.checkImpossible(t, p)
    if (t - (this.lastRunTick || 0) >= 10000) {
      this.lastRunTick = t
      this.devTick(t)
      for (const s of this.sigs) {
        if (s.metered && this.meter[s.id]) {
          this.runCheck(s, t)
        }
      }
    }
    if (this.devPending.length) {
      this.devEstimate(t)
    }
    this.now = { t, p, alloc }
    this.dataDirty = true
    this.detect(t)
  }

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
        delete this.running[id]
        delete this.impossible[id]
        delete this.activeStages[id]
        this.lastOffAt[id] = t
        this.changed()
        this.emit('finished', s, dur)
      }
    }
  }

  // keep 800 days of totals; drop the hour-by-hour split per appliance (and on-time) after 400 days
  pruneDays() {
    const keys = Object.keys(this.energy).sort()
    while (keys.length > MAX_DAYS) delete this.energy[keys.shift()]
    const cut = dayKey(Date.now() - HOURLY_DAYS * 86400e3)
    for (const k of keys) {
      if (k >= cut) {
        break
      }
      delete this.energy[k].ah
    }
    for (const id of Object.keys(this.impossible)) {
      if (!this.running[id]) {
        delete this.impossible[id]
      }
    }
  }

  /** Always-on load: the 5th percentile of the minute averages in a window (24 h by default), or null with under 30 minutes. */
  baseLoad(from = Date.now() - 86400e3, to = Date.now()) {
    const v = this.minutes
      .filter(m => m[0] > from && m[0] <= to)
      .map(m => m[1])
      .filter(x => x >= 0)
    if (v.length < 30) {
      return null
    }
    v.sort((a, b) => a - b)
    return v[Math.floor(v.length * 0.05)]
  }

  // ---------- step detection ----------
  detect(t) {
    const n = this.samples.length
    if (n < 2 * W) {
      return
    }
    const before = this.samples.slice(n - 2 * W, n - W).map(s => s.p)
    const after = this.samples.slice(n - W).map(s => s.p)
    const d = median(after) - median(before)
    if (Math.abs(d) < this.settings.threshold) {
      return
    }
    if (Math.max(...after) - Math.min(...after) > Math.max(20, Math.abs(d) * 0.25)) {
      return
    } // still settling
    if (t - this.lastEventT < 2 * W * 1000) {
      return
    }
    this.lastEventT = t
    this.handleEvent(this.samples[n - W].t, d)
  }

  matchSig(w, onlyRunning) {
    let best = null
    let be = Infinity
    for (const s of this.sigs) {
      if (s.metered || !s.watts) {
        continue
      }
      if (onlyRunning && !this.running[s.id]) {
        continue
      }
      const e = Math.abs(w - s.watts)
      if (e < tolFor(s.watts) * (onlyRunning ? 1.4 : 1) && e < be) {
        be = e
        best = s
      }
    }
    return best
  }

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
  }

  // base draw plus whichever of its learned extra stages (a dryer's heating element…) are on in this run
  curTotalWatts(s) {
    const active = this.activeStages[s.id]
    if (!active?.length || !s.stages?.length) {
      return s.watts
    }
    return s.watts + active.reduce((sum, id) => sum + (s.stages.find(x => x.id === id)?.watts || 0), 0)
  }

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
  }

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
  }

  applyMatch(ev, s) {
    ev.sig = s.id
    s.lastSeen = ev.t
    if (ev.dir === 'on') {
      this.running[s.id] = ev.t
    } else if (this.running[s.id]) {
      const dur = (ev.t - this.running[s.id]) / 1000
      ev.dur = dur
      s.runs = (s.runs || 0) + 1
      s.totalSec = (s.totalSec || 0) + dur
      delete this.running[s.id]
      delete this.activeStages[s.id]
      this.lastOffAt[s.id] = ev.t
      ev.counted = true
      this.recordRun(s, dur, ev.t)
      this.emit('finished', s, dur)
    }
  }

  // a finished run compared with the same appliance's own recent runs: flagged when far outside its pattern
  // an appliance with learned cycles: a run in one of them is normal; a new one is unusual only if far longer than all of them
  recordRun(s, dur, t = Date.now(), cyc = null) {
    if (!(dur > 0)) {
      return
    }
    const prior = s.recentRuns || []
    const others = cyc
      ? progStats(s).filter(p => p.id !== cyc.prog.id)
      : []
    const check = !cyc
      ? prior.length >= 5 && dur >= 60
      : cyc.isNew && others.length > 0 && dur >= 2.5 * Math.max(...others.map(p => p.dur))
    if (check) {
      const base = cyc
        ? Math.max(...others.map(p => p.dur))
        : median(prior)
      if (base >= 60) {
        const ratio = dur / base
        if (ratio >= 2.5 || ratio <= 0.4) {
          this.anomalies.unshift({
            id: uid(),
            t,
            sig: s.id,
            dur,
            base,
            ratio,
          })
          if (this.anomalies.length > MAX_ANOMALIES) {
            this.anomalies.length = MAX_ANOMALIES
          }
          this.changed()
          this.emit('anomaly', s, dur, base)
        }
      }
    }
    s.recentRuns = [...prior, dur].slice(-RECENT_RUNS)
  }

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
  }

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
      ;(this.cycleCache ??= {})[s.id] = {
        key,
        m: matchRun(s, b, el),
      }
    }
    return this.cycleCache[s.id].m
  }

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
  }

  forgetCycle(id, prog) {
    const s = this.sigById(id)
    if (!s?.progs?.some(x => x.id === prog)) {
      throw new Error('Unknown cycle')
    }
    s.progs = s.progs.filter(x => x.id !== prog)
    s.cycles = (s.cycles || []).filter(c => c.prog !== prog)
    this.cycleCache = {}
    this.changed()
  }

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
  }

  handleEvent(t, d) {
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
    }
    const meterSig = this.matchMeterChange(t, d)
    const stageMatch = meterSig
      ? null
      : this.matchRunningLevel(w, dir)
    const s
      = meterSig || stageMatch
        ? null
        : dir === 'off'
          ? this.matchSig(w, true) || this.matchSig(w)
          : this.matchSig(w)
    if (meterSig) {
      ev.sig = meterSig
      ev.metered = true
    } else if (stageMatch) {
      this.applyStage(ev, stageMatch)
    } else if (s) {
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
    }
    this.events.unshift(ev)
    if (this.events.length > MAX_EVENTS) {
      this.events.length = MAX_EVENTS
    }
    this.changed()
    this.emit('event', ev, s)
  }

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
  }

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
  }

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
      this.changed()
    }
  }

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
  }

  finishSet(s) {
    return s.finishSet ?? (s.finishMin != null && s.finishMin !== 5)
  }

  runLevel(s) {
    return s.estimated
      ? 0.5
      : this.runSet(s)
        ? s.runW
        : (s.learn?.runW ?? 5)
  }

  finishSecs(s) {
    return s.estimated
      ? 0
      : this.finishSet(s)
        ? s.finishMin * 60
        : (s.learn?.finishSec ?? 300)
  }

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
  }

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
  }

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
    this.changed()
    this.emit('event', ev, s)
  }

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
    this.changed()
    this.emit('event', ev, s)
    this.emit('finished', s, dur)
    this.recordRun(s, dur, tEnd, cyc)
  }

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
    this.anomalies = this.anomalies.filter(a => !(a.sig === s.id && a.t === last.end))
    L.finishSec = Math.max(L.finishSec || 0, Math.max(120, Math.round((gap / 1000) * 1.5)))
    this.dirty = true
    this.changed()
    this.emit(
      'learned',
      s,
      `a ${Math.round(gap / 60000)} min pause inside a run, so it now waits ${Math.round(L.finishSec / 60)} min before calling a run finished`,
    )
  }

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
  }

  forgetLearned(id) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    delete s.learn
    delete this.meterRun[id]
    this.changed()
  }

  // ---------- devices this plugin reads (Shellys and Matter devices) ----------
  // A source ('shelly', 'matter') hands over its full list whenever something in it changes. Each device:
  // { id, name, type, on (bool or undefined), values: { Watts? }, protocol, reachable, model, source }
  setSource(name, list, t = Date.now()) {
    this.sources[name] = Array.isArray(list)
      ? list
      : []
    const all = Object.values(this.sources).flat()
    const prev = new Map(this.devices.map(a => [a.id, a]))
    for (const a of all) {
      const p = prev.get(a.id)
      if (!p || typeof a.on !== 'boolean' || typeof p.on !== 'boolean' || a.on === p.on || isSensor(a)) {
        continue
      }
      const after = t - (SWITCH_WINDOW[a.protocol] ?? 10e3)
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
        const a = this.devById.get(s.devId)
        if (!a) {
          continue
        }
        if (!s.estimated && typeof a.values?.Watts === 'number') {
          this.meterReading(s, a.values.Watts, typeof a.on === 'boolean'
            ? a.on
            : undefined, t)
        } else if (s.estimated && typeof a.on === 'boolean') {
          this.meterReading(s, a.on
            ? this.estWatts(s)
            : 0, a.on, t)
        }
      }
    }
    this.dataDirty = true
  }

  device(id) {
    return this.devById.get(id)
  }

  /** The average of a reading ('Temperature' or 'Humidity') across the sensors this plugin reads, or null. */
  sensorAverage(key) {
    const v = this.devices
      .filter(a => a.reachable !== false && typeof a.values?.[key] === 'number')
      .map(a => a.values[key])
    return v.length
      ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10
      : null
  }

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
      if (r == null) {
        est.skip++
        changed = true
        continue
      }
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
      this.dirty = true
    }
  }

  devStep(e) {
    const from = Math.max(e.after, e.t - 15e3)
    if (e.t - e.after > 60e3) {
      return null
    }
    const S = this.samples
    const inW = (a, b) => S.filter(x => x.t >= a && x.t <= b).map(x => x.p)
    const bef = inW(from - 30e3, from)
    const aft = inW(e.t + 3e3, e.t + 30e3)
    if (bef.length < 5 || aft.length < 5) {
      return null
    }
    const busy
      = this.devEvents.some(h => h.id !== e.id && h.t >= from - 30e3 && h.t <= e.t + 30e3)
        || this.meterChanges.some(c => c.t >= from - 30e3 && c.t <= e.t + 30e3 && this.sigById(c.sid)?.devId !== e.id)
    if (busy) {
      return null
    }
    const mb = median(bef)
    const ma = median(aft)
    const noise = Math.max(mad(bef), mad(aft))
    const w = e.on
      ? ma - mb
      : mb - ma
    if (noise > 40) {
      return null
    }
    if (w < Math.max(1.5, 3 * noise)) {
      return w < -Math.max(5, 3 * noise)
        ? null
        : { small: true }
    }
    return { w }
  }

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
        t: x.t,
      }
    }
    return out
  }

  estWatts(s) {
    if (s.estW > 0) {
      return s.estW
    }
    const x = this.devEst[s.devId]
    return x?.ws.length
      ? median(x.ws)
      : 0
  }

  estReset(id) {
    delete this.devEst[id]
    this.dirty = true
  }

  // every 10 s: keep estimated appliances' readings (on/off × watts) fresh when nothing has changed for a while
  devTick(t) {
    for (const s of this.sigs) {
      if (s.estimated && s.devId) {
        const a = this.device(s.devId)
        if (a && typeof a.on === 'boolean') {
          this.meterReading(s, a.on
            ? this.estWatts(s)
            : 0, a.on, t)
        }
      }
    }
  }

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
      throw new Error('That device isn\'t answering right now, so it can\'t be tracked yet.')
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
    if (this.sigs.some(s => s.devId === devId)) {
      throw new Error(`"${a.name}" is tracked already.`)
    }
    let s = sigId
      ? this.sigById(sigId)
      : this.sigs.find(x => x.name.trim().toLowerCase() === a.name.trim().toLowerCase() && !x.devId)
    if (sigId && !s) {
      throw new Error('Unknown appliance')
    }
    if (sigId && s.devId) {
      throw new Error(`"${s.name}" is measured by a device already. Stop tracking that one first.`)
    }
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
    this.changed()
    this.emit('sigs')
    return s
  }

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
  }

  // Stop tracking: the appliance stays (with its history) and is recognised from whole-house steps again
  untrack(id) {
    const s = this.sigs.find(x => x.id === id && x.devId)
    if (!s) {
      throw new Error('That appliance isn\'t tracked by a device.')
    }
    delete s.devId
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
  }

  // an appliance measured through another Homebridge plugin before ("relink"): keep it recognised from whole-house steps, and stop asking
  keepSteps(id) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    delete s.relink
    this.changed()
  }

  // Ways to save (lib/insights.js): worked out at most once a minute, or when something changed
  insights(now = Date.now()) {
    const key = `${this.version}:${Math.floor(now / 60e3)}`
    if (this.insightCache?.key !== key) {
      this.insightCache = {
        key,
        v: insights(this, now),
      }
    }
    return this.insightCache.v
  }

  dismissTip(key) {
    if (!key) {
      this.settings.tipsDismissed = {}
      this.changed()
      return
    } // show all again
    const t = this.insights().tips.find(x => x.key === key)
    this.settings.tipsDismissed[String(key).slice(0, 80)] = t
      ? (t.costYear ?? t.kwhYear ?? 0)
      : 0
    const k = Object.keys(this.settings.tipsDismissed)
    if (k.length > 300) {
      delete this.settings.tipsDismissed[k[0]]
    }
    this.changed()
  }

  dismissAnomaly(id) {
    this.anomalies = id
      ? this.anomalies.filter(a => a.id !== id)
      : []
    this.changed()
  }

  newSig(name, extra = {}) {
    const s = {
      id: uid(),
      name: clean(name, 60),
      icon: null,
      room: '',
      watts: 0,
      count: 0,
      stages: [],
      runs: 0,
      totalSec: 0,
      kwh: 0,
      createdAt: Date.now(),
      exposed: true,
      statusType: 'none',
      statusCount: 1,
      steadyOutlet: false,
      steadyIdleMin: 10,
      ...extra,
    }
    this.sigs.push(s)
    this.noteRoom(s.room)
    return s
  }

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
    let s = this.sigs.find(x => x.name.toLowerCase() === name.toLowerCase())
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
      s = this.newSig(name)
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
    const mine = this.events.filter(e => e.sig === s.id).sort((a, b) => a.t - b.t)
    let on = null
    let curW = 0
    let active = []
    let wattsSum = 0
    let wattsN = 0
    const durs = []
    s.runs = 0
    s.totalSec = 0
    s.stages = []
    delete this.running[s.id]
    delete this.activeStages[s.id]
    for (const e of mine) {
      const w = Math.abs(e.d)
      delete e.stage
      delete e.stageOn
      if (!on) {
        if (e.dir !== 'off') {
          on = e
          curW = w
          active = []
          wattsSum += w
          wattsN++
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
      } else if (Math.abs(w - curW) < tolFor(curW)) {
        e.dur = (e.t - on.t) / 1000
        s.runs++
        s.totalSec += e.dur
        durs.push(e.dur)
        // runs from before it had a name were counted as "Other": credit them to it in the daily figures
        if (!e.counted) {
          this.creditFromOther(s.id, on.t, e.t, wattsSum / wattsN)
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
    for (const e of this.events) {
      if (!e.sig && !e.metered && s.watts && Math.abs(Math.abs(e.d) - s.watts) < tolFor(s.watts)) {
        e.sig = s.id
      }
    }
    this.settings.dismissed = this.settings.dismissed.filter(x => x.name !== s.name)
    this.changed()
    this.emit('sigs')
    return s
  }

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
  }

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
  }

  dismissSuggestion(name, w) {
    this.settings.dismissed.push({
      name: clean(name, 60),
      w: +w || 0,
    })
    if (this.settings.dismissed.length > 200) {
      this.settings.dismissed.shift()
    }
    this.changed()
  }

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
        suggestion: suggestFor(c, { sigs: this.sigs, devEvents: this.devEvents, dismissed: this.settings.dismissed }),
      }))
  }

  editSig(id, o = {}) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    if (o.name != null && clean(o.name, 60)) {
      const n = clean(o.name, 60)
      if (this.sigs.some(x => x !== s && x.name.toLowerCase() === n.toLowerCase())) {
        throw new Error(`There's already an appliance called "${n}".`)
      }
      s.name = n
    }
    if (o.icon !== undefined) {
      s.icon = cleanIcon(o.icon)
    }
    if (o.room != null) {
      s.room = this.cleanRoom(o.room)
      this.noteRoom(s.room)
    }
    if (o.exposed != null) {
      s.exposed = o.exposed === true
    }
    if (o.statusType != null) {
      s.statusType = normStatusType(o.statusType, s.statusType)
    }
    if (o.statusCount != null) {
      s.statusCount = normStatusCount(o.statusCount)
    }
    if (o.steadyOutlet != null) {
      s.steadyOutlet = normSteady(o.steadyOutlet)
    }
    if (o.steadyIdleMin != null) {
      s.steadyIdleMin = normIdleMin(o.steadyIdleMin)
    }
    // running level and finish wait: a number is a figure typed on the settings page; '' or null goes back to learned (or the default)
    if (o.runW !== undefined && s.metered && !s.estimated) {
      if (o.runW === null || o.runW === '') {
        s.runWSet = false
        delete s.runW
      } else {
        s.runW = Math.min(5000, Math.max(0.5, +o.runW || 5))
        s.runWSet = true
      }
    }
    if (o.finishMin !== undefined && s.metered && !s.estimated) {
      if (o.finishMin === null || o.finishMin === '') {
        s.finishSet = false
        delete s.finishMin
      } else {
        s.finishMin = Math.min(240, Math.max(0, +o.finishMin || 0))
        s.finishSet = true
      }
    }
    if (o.offMains != null) {
      s.offMains = o.offMains === true
    }
    this.changed()
    this.emit('sigs')
    return s
  }

  forgetSig(id) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    this.sigs = this.sigs.filter(x => x !== s)
    for (const k of [
      this.meter,
      this.meterRun,
      this.running,
      this.activeStages,
      this.lastOffAt,
    ]) delete k[id]
    for (const e of this.events) {
      if (e.sig === id) {
        e.sig = null
        delete e.dur
        if (e.metered) {
          e.gone = true
        }
      }
    }
    this.events = this.events.filter(e => !e.gone)
    this.anomalies = this.anomalies.filter(a => a.sig !== id)
    this.changed()
    this.emit('sigs')
  }

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
  }

  matterById(id) {
    return this.matterDevices.find(m => m.id === id)
  }

  matterByNode(nodeId) {
    return this.matterDevices.find(m => m.nodeId === String(nodeId))
  }

  matterPairing(id) {
    const m = this.matterById(id)
    if (!m) {
      throw new Error('Unknown Matter device')
    }
    m.status = 'pairing'
    m.error = null
    this.changed()
    return m
  }

  matterPaired(id, nodeId) {
    const m = this.matterById(id)
    if (!m) {
      return
    }
    m.nodeId = String(nodeId)
    m.status = 'connecting'
    m.error = null
    this.changed()
  }

  matterFailed(id, error) {
    const m = this.matterById(id)
    if (!m) {
      return
    }
    m.status = 'failed'
    m.error = String(error || 'Failed').slice(0, 300)
    this.changed()
  }

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
      this.changed()
      this.matterPublish()
    }
  }

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
  }

  matterValue(nodeId, endpoint, key, value) {
    const d = this.matterState[String(nodeId)]?.devices?.[endpoint]
    if (!d || d.values[key] === value) {
      return
    }
    d.values[key] = value
    this.matterPublish()
  }

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
  }

  matterPublish() {
    this.setSource('matter', this.matterList())
  }

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
  }

  // ---------- settings ----------
  setSettings(o = {}) {
    const S = this.settings
    if (o.em != null) {
      const host = String(o.em.host ?? S.em.host).trim()
      if (host && !lanHost(host)) {
        throw new Error(notLanMessage([host]))
      }
      const em = {
        host: lanHost(host),
        channel: /^(?:auto|sum|em1?:\d|pm1:\d|switch:\d)$/.test(o.em.channel ?? S.em.channel)
          ? (o.em.channel ?? S.em.channel)
          : 'auto',
      }
      if (em.host !== S.em.host || em.channel !== S.em.channel) {
        S.em = em
        this.emit('em')
      }
    }
    if (o.shellyHosts != null) {
      const bad = rejectedHosts(o.shellyHosts)
      if (bad.length) {
        throw new Error(notLanMessage(bad))
      }
      S.shellyHosts = hostList(o.shellyHosts)
      this.emit('shellyHosts')
    }
    if (o.threshold != null) {
      S.threshold = Math.min(2000, Math.max(10, Math.round(+o.threshold) || 40))
    }
    if (o.standbyThreshold != null) {
      S.standbyThreshold = Math.min(50, Math.max(0, +o.standbyThreshold || 0))
    }
    if (o.currency != null) {
      S.currency = clean(o.currency, 4) || '$'
    }
    if (o.tariff != null) {
      S.tariff = cleanTariff(o.tariff)
      if (!S.tariff.periods.length || S.tariff.mode !== 'tou') {
        if (S.cheapTile) {
          S.cheapTile = false
          this.emit('tiles')
        }
      }
    }
    if (o.other != null) {
      S.other = { on: o.other.on !== false, name: clean(o.other.name ?? S.other.name, 32) || 'Other appliances' }
      this.emit('tiles')
    }
    if (o.cheapTile != null) {
      const want = o.cheapTile === true
      if (want && !(S.tariff.mode === 'tou' && S.tariff.periods.length)) {
        throw new Error('"Cheap power now" needs a time-of-use plan with at least one period.')
      }
      S.cheapTile = want
      this.emit('tiles')
    }
    this.changed()
  }

  // ---------- summaries for the settings page ----------
  /** Energy and cost per appliance over the last `days` days (1 = today), plus Other, the total and the always-on load. */
  summary(days = 1, now = Date.now()) {
    days = Math.min(366, Math.max(1, Math.round(+days) || 1))
    const T = this.settings.tariff
    const plan = hasPlan(T)
    const keys = []
    for (let i = 0; i < days; i++) keys.push(dayKey(now - i * 86400e3))
    const per = {}
    let total = 0
    let totalCost = 0
    let other = 0
    let otherCost = 0
    let daysWithData = 0
    for (const k of keys) {
      const d = this.energy[k]
      if (!d) {
        continue
      }
      daysWithData++
      total += d.total || 0
      totalCost += costOf(T, k, d.total, d.h)
      other += d.other || 0
      otherCost += costOf(T, k, d.other, d.oh)
      for (const [id, kwh] of Object.entries(d.apps || {})) {
        const x = (per[id] ??= { kwh: 0, cost: 0 })
        x.kwh += kwh
        x.cost += costOf(T, k, kwh, d.ah?.[id])
      }
    }
    const rows = Object.entries(per)
      .map(([id, x]) => {
        const s = this.sigById(id)
        return s
          ? {
              id,
              name: s.name,
              icon: s.icon,
              kwh: x.kwh,
              cost: x.cost,
            }
          : null
      })
      .filter(r => r && r.kwh > 0.0005)
      .sort((a, b) => b.kwh - a.kwh)
    const base = this.baseLoad(now - 86400e3, now)
    const fixed = fixedPerDay(T) * daysWithData
    const standby = this.sigs
      .filter(s => s.metered && !s.estimated && (s.standbyW || 0) >= (this.settings.standbyThreshold || 1))
      .map(s => ({ id: s.id, name: s.name, w: Math.round(s.standbyW * 10) / 10 }))
      .sort((a, b) => b.w - a.w)
    return {
      days,
      daysWithData,
      plan,
      currency: this.settings.currency,
      rows,
      other: { kwh: other, cost: otherCost },
      total: { kwh: total, cost: totalCost },
      fixed,
      base: base == null
        ? null
        : Math.round(base),
      baseYearKwh: base == null
        ? null
        : Math.round(base * 8.76),
      standby,
      anomalies: this.anomalies
        .filter(a => a.t > now - Math.max(days, 7) * 86400e3)
        .slice(0, 20)
        .map(a => ({ ...a, name: this.sigById(a.sig)?.name || '?' })),
    }
  }

  /** What the settings page needs, in one go. Never includes anything secret (there is nothing secret here). */
  view() {
    const today = this.energy[dayKey(Date.now())] || {}
    const est = this.estSummary()
    const hid = new Set(this.settings.devHidden)
    const trackedBy = new Map(this.sigs.filter(s => s.devId).map(s => [s.devId, s.id]))
    return {
      settings: {
        ...this.settings,
        web: webPublic(this.settings.web),
      },
      now: this.now
        ? {
            t: this.now.t,
            p: Math.round(this.now.p),
            other: Math.round(this.now.alloc.other),
          }
        : null,
      sigs: this.sigs.map(s => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        room: s.room || '',
        watts: Math.round(s.watts || 0),
        runs: s.runs || 0,
        kwh: s.kwh || 0,
        today: today.apps?.[s.id] || 0,
        running: !!this.running[s.id],
        nowW: Math.round(this.now?.alloc.per[s.id] || 0),
        stages: (s.stages || []).length,
        metered: !!s.metered,
        estimated: !!s.estimated,
        estW: s.estW ?? null,
        estNow: s.estimated
          ? Math.round(this.estWatts(s) * 10) / 10
          : null,
        devId: s.devId || null,
        devName: s.devId
          ? this.device(s.devId)?.name || null
          : null,
        devOk: s.devId
          ? !!this.device(s.devId) && this.device(s.devId).reachable !== false
          : null,
        relink: s.relink || null,
        exposed: s.exposed !== false,
        statusType: s.statusType,
        statusCount: s.statusCount,
        steadyOutlet: s.steadyOutlet,
        steadyIdleMin: s.steadyIdleMin,
        runW: s.metered && !s.estimated
          ? this.runLevel(s)
          : null,
        runSrc: this.runSet(s)
          ? 'set'
          : s.learn?.runW != null
            ? 'learned'
            : 'default',
        finishMin: s.metered && !s.estimated
          ? Math.round(this.finishSecs(s) / 6) / 10
          : null,
        finishSrc: this.finishSet(s)
          ? 'set'
          : s.learn?.finishSec != null
            ? 'learned'
            : 'default',
        learnCycles: s.learn?.cycles || 0,
        standbyLearned: s.learn?.standby ?? null,
        standbyW: s.standbyW != null
          ? Math.round(s.standbyW * 10) / 10
          : null,
        remaining: this.remainingSec(s.id),
        lastSeen: s.lastSeen || null,
        cycle: (c => (c
          ? { name: c.name, sure: c.sure }
          : null))(this.running[s.id] && this.cycleNow(s)),
        cycles:
          s.metered && !s.estimated
            ? progStats(s).map(({ id, name, dur, kwh, n }) => ({ id, name, dur, kwh, n }))
            : [],
      })),
      devices: this.devices.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        on: a.on,
        watts: a.values?.Watts ?? null,
        protocol: a.protocol,
        host: a.host || null,
        reachable: a.reachable !== false,
        sensor: isSensor(a),
        model: a.model || '',
        source: a.source || null,
        est: est[a.id] || null,
        tracked: trackedBy.get(a.id) || null,
        hidden: hid.has(a.id),
      })),
      matter: this.matterDevices,
      matterSystem: this.matterSystem,
      patterns: this.patterns(),
      imported: this.imported,
      insights: this.insights(),
    }
  }
}
