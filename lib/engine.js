// Energy engine: turns the whole-house reading (Shelly EM, every second) into recognised appliances, their runs and
// their energy.
//
// Sources of truth:
//  - whole-house power: processSample() every second
//  - devices this plugin reads itself (Shellys, Matter): setSource() whenever one of them changes
// Appliances ("sigs") are either learned from power steps, or measured ("metered") by a device's own watts, or
// estimated from a device's on/off state and the watts it was seen to switch.
//
// The class holds the state, saving and loading, settings and the view; its methods for steps, devices and reports are in
// lib/engine-steps.js, lib/engine-devices.js and lib/engine-reports.js, installed below. Shared constants: lib/engine-shared.js.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { progStats } from './cycles.js'
import { deviceMethods } from './engine-devices.js'
import { reportMethods } from './engine-reports.js'
import {
  clean,
  cleanDevEst,
  GAP,
  HOURLY_DAYS,
  MAX_DAYS,
  MAX_DEV_EVENTS,
  MAX_EVENTS,
  MAX_FILL,
  MAX_GAP_KW,
  MAX_MATTER,
  MINUTE_HISTORY,
  normBillDay,
  roundJson,
  sameName,
  SAMPLE_HISTORY,
  STALE_READING,
} from './engine-shared.js'
import { stepMethods } from './engine-steps.js'
import {
  cleanIcon,
  dayKey,
  EM_CHANNEL,
  isSensor,
  normIdleMin,
  normStatusCount,
  normStatusType,
  normSteady,
  uid,
} from './engine-util.js'
import { hostList, lanHost, notLanMessage, rejectedHosts } from './hosts.js'
import { privateDir } from './private-dir.js'
import { cleanTariff, hasPlan } from './tariff.js'
import { cleanWeb, webPublic } from './web-auth.js'

export { dayKey }
export { billPeriod } from './engine-shared.js'

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
    this.varBase = {}
    this.varLow = {}
    this.matterState = {}
    this.matterSystem = { ok: true, error: null }
    this.load(defaults)
  }

  // ---------- persistence ----------
  // Saved in two files: state.json (settings, appliances, today and yesterday) every few minutes, and state-history.json
  // (older days) only when they change. Each is written to a .tmp file, forced to disk, then put in place; once a day the
  // copy it replaces is kept as .prev. A file that can't be read is kept as .bad and its .prev used instead.
  get histFile() {
    return `${this.file.replace(/\.json$/, '')}-history.json`
  }

  readSaved(file, what) {
    try {
      return {
        d: JSON.parse(fs.readFileSync(file, 'utf8')),
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        return { d: null }
      }
      try {
        fs.copyFileSync(file, `${file}.bad`)
      } catch {}
      try {
        const d = JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8'))
        this.log.warn(
          `Could not read the saved ${what} (${e.message}). Using the copy from up to a day earlier instead; the unreadable file was kept as ${path.basename(file)}.bad`,
        )
        this.recovered = {
          at: Date.now(),
          what,
        }
        ;(this.prevAt ??= {})[file] = Date.now() // keep this good copy for a day: the next saves mustn't put the damaged file there
        return { d, prev: true }
      } catch {}
      this.log.warn(
        `Could not read the saved ${what} (${e.message}), and there's no earlier copy. Starting fresh; the unreadable file was kept as ${path.basename(file)}.bad`,
      )
      this.recovered = {
        at: Date.now(),
        what,
        fresh: true,
      }
      return { d: null }
    }
  }

  load(defaults = {}) {
    const d = this.readSaved(this.file, 'data').d || {}
    const h = this.readSaved(this.histFile, 'history').d
    if (h?.energy && typeof h.energy === 'object') {
      d.energy = {
        ...h.energy,
        ...(d.energy && typeof d.energy === 'object'
          ? d.energy
          : {}),
      }
    }
    this.fromData(d, defaults)
  }

  writeSafe(file, text) {
    const tmp = `${file}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.prevAt ??= {}
    if (this.prevAt[file] == null) {
      try {
        this.prevAt[file] = fs.statSync(`${file}.prev`).mtimeMs
      } catch {
        this.prevAt[file] = 0
      }
    }
    if (Date.now() - this.prevAt[file] > 86400e3) {
      try {
        fs.copyFileSync(file, `${file}.prev`)
        this.prevAt[file] = Date.now()
      } catch {}
    }
    fs.renameSync(tmp, file)
    try {
      const dfd = fs.openSync(path.dirname(file), 'r')
      try {
        fs.fsyncSync(dfd)
      } finally {
        fs.closeSync(dfd)
      }
    } catch {} // the rename itself, on disk
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
      budget: Number.isFinite(+S.budget) && +S.budget > 0
        ? Math.min(1e6, +S.budget)
        : 0, // a monthly electricity budget (0 = none)
      budgetTile: S.budgetTile === true,
      billDay: normBillDay(S.billDay), // the day of the month each bill starts on (1 = calendar months)
      dismissed: Array.isArray(S.dismissed)
        ? S.dismissed.filter(x => x && x.name).slice(-200)
        : [],
      rooms: Array.isArray(S.rooms)
        ? [
            ...new Set(S.rooms.map(r => clean(r, 40)).filter(Boolean)),
          ].slice(0, 100)
        : [],
      roomsOrdered: S.roomsOrdered === true, // the rooms are in the order the user set (otherwise shown A–Z)
      // rooms chosen for devices not tracked yet: the appliance gets it when the device is tracked
      devRooms: Object.fromEntries(
        Object.entries(S.devRooms && typeof S.devRooms === 'object'
          ? S.devRooms
          : {})
          .filter(([k, v]) => k.length <= 200 && clean(v, 40))
          .slice(0, 500)
          .map(([k, v]) => [
            k,
            clean(v, 40),
          ]),
      ),
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
    // readings older than the last one are ignored: a time saved while the clock was far ahead would block them all
    this.lastT = d.lastT && d.lastT < Date.now() + 5 * 60e3
      ? d.lastT
      : null
    this.lastWh = Number.isFinite(d.lastWh)
      ? d.lastWh
      : null // the meter's own energy count at the last reading (Wh)
    this.seenSinceWh = Number.isFinite(d.seenSinceWh)
      ? d.seenSinceWh
      : 0 // kWh the readings added since that count last moved
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
    // "Refresh in Apple Home": how many times each Matter outlet was given a new identity (none = its original one)
    this.matterGen
      = d.matterGen && typeof d.matterGen === 'object'
        ? Object.fromEntries(Object.entries(d.matterGen).filter(([, n]) => Number.isInteger(n) && n > 0 && n < 1e6))
        : {}
    this.imported = d.imported || null // { at, from, counts } of the last import
    for (const s of this.sigs) this.noteRoom(s.room)
  }

  toData() {
    return {
      format: 'home-energy-1',
      settings: this.settings,
      sigs: this.sigs,
      events: this.events,
      minutes: this.minutes,
      energy: this.energy,
      running: this.running,
      activeStages: this.activeStages,
      lastOffAt: this.lastOffAt,
      otherKwh: this.otherKwh,
      lastT: this.lastT,
      lastWh: this.lastWh,
      seenSinceWh: this.seenSinceWh,
      devEst: this.devEst,
      devEvents: this.devEvents,
      matterIds: this.matterIds,
      hapIds: this.hapIds,
      matterGen: this.matterGen,
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
      privateDir(path.dirname(this.file))
      const all = this.toData()
      const cut = dayKey(Date.now() - 86400e3)
      const recent = {}
      const old = {}
      for (const [k, v] of Object.entries(all.energy)) {
        (k >= cut
          ? recent
          : old)[k] = v
      }
      const hist = JSON.stringify({ format: 'home-energy-history-1', energy: old }, roundJson)
      if (hist !== this.histText) {
        this.writeSafe(this.histFile, hist)
        this.histText = hist
      } // older days first: the main file never points past them
      const text = JSON.stringify({ ...all, energy: recent }, roundJson)
      this.writeSafe(this.file, text)
      this.savedBytes = text.length
      this.histBytes = hist.length
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

  // a change that comes from the readings (a power step, a run starting or ending): shown at once, saved with the readings
  dataChanged() {
    this.version++
    this.dataDirty = true
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

  // Edit rooms (Your appliances): the order rooms are listed in, renaming one (onto another: they become one), removing one
  setRoomOrder(list) {
    const want = [
      ...new Set((Array.isArray(list)
        ? list
        : []).map(r => this.cleanRoom(r)).filter(Boolean)),
    ]
    const known = this.settings.rooms
    this.settings.rooms = [
      ...want.filter(r => known.includes(r)),
      ...known.filter(r => !want.includes(r)),
    ]
    this.settings.roomsOrdered = true
    this.changed()
  }

  renameRoom(from, to) {
    from = this.cleanRoom(from)
    to = this.cleanRoom(to)
    if (!from || !this.settings.rooms.includes(from)) {
      throw new Error('Unknown room')
    }
    if (!to) {
      throw new Error('Type the room\'s new name')
    }
    if (from === to) {
      return
    }
    for (const s of this.sigs) {
      if ((s.room || '') === from) {
        if (
          this.sigs.some(
            x => x !== s && (x.room || '') === to && x.name.trim().toLowerCase() === s.name.trim().toLowerCase(),
          )
        ) {
          throw new Error(`"${to}" already has an appliance called "${s.name}". Rename one of them first.`)
        }
      }
    }
    for (const s of this.sigs) {
      if ((s.room || '') === from) {
        s.room = to
      }
    }
    for (const k of Object.keys(this.settings.devRooms)) {
      if (this.settings.devRooms[k] === from) {
        this.settings.devRooms[k] = to
      }
    }
    const R = this.settings.rooms
    const i = R.indexOf(from)
    if (R.includes(to)) {
      R.splice(i, 1)
    } else {
      R[i] = to
    }
    this.changed()
    this.emit('sigs')
  }

  removeRoom(name) {
    name = this.cleanRoom(name)
    const R = this.settings.rooms
    if (!R.includes(name)) {
      throw new Error('Unknown room')
    }
    for (const s of this.sigs) {
      if ((s.room || '') === name) {
        if (this.sigs.some(x => x !== s && !x.room && x.name.trim().toLowerCase() === s.name.trim().toLowerCase())) {
          throw new Error(`"${s.name}" would clash with another "${s.name}" with no room. Rename one of them first.`)
        }
      }
    }
    for (const s of this.sigs) {
      if ((s.room || '') === name) {
        s.room = ''
      }
    }
    for (const k of Object.keys(this.settings.devRooms)) {
      if (this.settings.devRooms[k] === name) {
        delete this.settings.devRooms[k]
      }
    }
    R.splice(R.indexOf(name), 1)
    this.changed()
    this.emit('sigs')
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

  sigById(id) {
    return this.sigs.find(x => x.id === id)
  }

  // its name, with its room when another appliance has the same name ("Downlights (Hall)"), for the log
  label(s) {
    return this.sigs.some(x => x !== s && sameName(x.name, s.name))
      ? `${s.name} (${s.room || 'no room'})`
      : s.name
  }

  // wh: the meter's own count of energy drawn (Wh), when it gives one. A gap of more than 10 s between readings (a restart,
  // Wi-Fi dropping out) is filled from that count, spread evenly over the gap and put on "Other".
  processSample(t, p, q = null, wh = null) {
    if (!Number.isFinite(p)) {
      return
    }
    if (this.lastT && t <= this.lastT) {
      // a reading a moment older than the last one is ignored, so nothing is counted twice; a clock put back right
      // after running ahead starts afresh, or every reading would be lost until real time caught up
      if (this.lastT - t < 5 * 60e3) {
        return
      }
      this.lastT = null
    }
    const d = this.dayRec(t)
    const alloc = this.allocate(p)
    wh = Number.isFinite(wh) && wh >= 0
      ? wh
      : null
    if (wh != null && d.wh0 == null) {
      d.wh0 = this.lastWh ?? wh
    } // the count when the day began (for the daily check)
    if (this.lastT) {
      const gap = t - this.lastT
      const k = Math.min(gap / 1000, 10) / 3.6e6
      const hr = new Date(t).getHours()
      const hz = () => Array.from({ length: 24 }).fill(0)
      const add = (Math.max(p, 0) + alloc.offMains) * k
      d.total += add
      ;(d.h ??= hz())[hr] += add
      const seen = Math.max(p, 0) * k
      if (wh != null && d.wh0 != null) {
        d.seen = (d.seen || 0) + seen
      } // what the readings added up to, over the same span as the count (daily check)
      if (gap > GAP && gap <= MAX_FILL) {
        // the count's rise since it last moved, less what the readings already added since then (some Shellys move it only
        // once a minute) and the 10 s this reading is credited with
        let fill = 0
        const used = wh != null && this.lastWh != null && wh >= this.lastWh
          ? (wh - this.lastWh) / 1000
          : null
        if (used != null && used <= (gap / 3.6e6) * MAX_GAP_KW) {
          fill = Math.max(0, used - this.seenSinceWh - seen)
        }
        this.fillGap(this.lastT + GAP, t, fill)
      }
      if (wh != null) {
        this.seenSinceWh = wh !== this.lastWh
          ? 0
          : this.seenSinceWh + seen
      }
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
    if (wh != null) {
      if (this.lastWh != null && wh < this.lastWh) {
        d.whReset = true
      }
      this.lastWh = wh
      d.wh1 = wh
    } // whReset: the count started again (a new meter, a reset)
    this.samples.push({
      t,
      p: Math.round(p * 10) / 10,
      q: Number.isFinite(q)
        ? Math.round(q)
        : null,
    }) // q: reactive power, when the meter gives it
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

  // the time from t0 to t1 had no readings: kwh (from the meter's count, or 0 without one) spread evenly over it, hour by hour
  fillGap(t0, t1, kwh) {
    const hz = () => Array.from({ length: 24 }).fill(0)
    for (let a = t0; a < t1;) {
      const h = new Date(a)
      h.setMinutes(60, 0, 0)
      const b = Math.min(t1, h.getTime())
      const d = this.dayRec(a)
      const hr = new Date(a).getHours()
      const part = (kwh * (b - a)) / (t1 - t0)
      d.miss = (d.miss || 0) + (b - a) / 1000
      if (part > 0) {
        d.total += part
        ;(d.h ??= hz())[hr] += part
        d.other = (d.other || 0) + part
        ;(d.oh ??= hz())[hr] += part
        d.fill = (d.fill || 0) + part
        this.otherKwh += part
      }
      a = b
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

  editSig(id, o = {}) {
    const s = this.sigById(id)
    if (!s) {
      throw new Error('Unknown appliance')
    }
    if (o.name != null && clean(o.name, 60)) {
      const n = clean(o.name, 60)
      const room = o.room != null
        ? this.cleanRoom(o.room)
        : s.room || ''
      if (this.sigs.some(x => x !== s && sameName(x.name, n) && (x.room || '') === room)) {
        throw new Error(`There's already an appliance called "${n}" in ${room || 'No room'}.`)
      }
      s.name = n
    } else if (
      o.room != null
      && this.sigs.some(x => x !== s && sameName(x.name, s.name) && (x.room || '') === this.cleanRoom(o.room))
    ) {
      throw new Error(`There's already an appliance called "${s.name}" in ${this.cleanRoom(o.room) || 'No room'}.`)
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
    if (o.alertLong != null) {
      if (o.alertLong === true) {
        s.alertLong = true
      } else {
        delete s.alertLong
      }
    }
    if (o.variable != null && !s.metered) {
      if (o.variable === true) {
        s.variable = true
      } else {
        delete s.variable
        delete this.varBase[s.id]
      }
      delete s.oddEnds
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
    this.changed()
    this.emit('sigs')
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
        channel: EM_CHANNEL.test(o.em.channel ?? S.em.channel)
          ? (o.em.channel ?? S.em.channel)
          : 'auto',
      }
      if (em.host !== S.em.host || em.channel !== S.em.channel) {
        // another meter: its count isn't comparable (today left out of the check)
        S.em = em
        this.lastWh = null
        this.seenSinceWh = 0
        const d = this.energy[dayKey(Date.now())]
        if (d?.wh0 != null) {
          d.whReset = true
        }
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
    if (o.budget != null) {
      const b = +o.budget
      if (!(b >= 0 && b <= 1e6)) {
        throw new Error('The budget must be a number from 0 (none) up.')
      }
      S.budget = Math.round(b * 100) / 100
      if (!S.budget && S.budgetTile) {
        S.budgetTile = false
      }
      this.emit('tiles')
    }
    if (o.billDay != null) {
      S.billDay = normBillDay(o.billDay)
    }
    if (o.budgetTile != null) {
      S.budgetTile = o.budgetTile === true && S.budget > 0 && hasPlan(S.tariff)
      this.emit('tiles')
    }
    this.changed()
  }

  /** What the settings page needs, in one go. Never includes anything secret (there is nothing secret here). */
  view() {
    const today = this.energy[dayKey(Date.now())] || {}
    const est = this.estSummary()
    const hid = new Set(this.settings.devHidden)
    const trackedBy = new Map(this.sigs.flatMap(s => this.devsOf(s).map(d => [d, s.id])))
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
      otherToday: today.other || 0,
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
          ? this.devsOf(s)
              .map(id => this.device(id)?.name || 'a device not connected')
              .join(' + ')
          : null,
        devOk: s.devId
          ? this.devsOf(s).every(id => this.device(id) && this.device(id).reachable !== false)
          : null,
        devs: this.devsOf(s).map(id => ({
          id,
          name: this.device(id)?.name || id,
          ok: !!this.device(id) && this.device(id).reachable !== false,
        })),
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
        alertLong: !!s.alertLong,
        longRun: this.longNow(s),
        variable: !!s.variable,
        sure: this.confidence(s),
        varHint: !s.variable && !s.metered && (s.oddEnds || 0) >= 3 && s.oddEnds >= (s.runs || 0) * 0.4,
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
        room: this.settings.devRooms[a.id] || '',
      })),
      matter: this.matterDevices,
      matterSystem: this.matterSystem,
      patterns: this.patterns(),
      imported: this.imported,
      insights: this.insights(),
      curve: this.curve(),
      month: this.monthStatus(),
      week: this.weekHours(),
      health: this.health(),
    }
  }
}
Object.assign(Engine.prototype, stepMethods, deviceMethods, reportMethods)
