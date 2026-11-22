// Backups: made by Settings → Data → Download a backup (format 'home-energy-1'), kept in <data>/backups, and restored from
// there or from a chosen file. A restore takes appliances, power steps, runs, daily and hourly energy, learned watts
// and run learning, Matter devices and the energy settings; never the web page's PIN or sign-ins.
import fs from 'node:fs'
import path from 'node:path'

import { cleanIcon, EM_CHANNEL, normIdleMin, normStatusCount, normStatusType, normSteady, uid } from './engine-util.js'
import { hostList } from './hosts.js'
import { privateDir } from './private-dir.js'
import { cleanTariff } from './tariff.js'

const MAX_EVENTS = 2000
// an id: letters, digits, _ and -, but never a name every JavaScript object has (used as keys in plain objects)
const SPECIAL = new Set(['__proto__', 'constructor', 'prototype'])
const okId = v => typeof v === 'string' && /^[\w-]{1,40}$/.test(v) && !SPECIAL.has(v)
function str(v, n) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}
function num(v) {
  return Number.isFinite(+v)
    ? +v
    : 0
}
const ymd = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)
const ownDevice = id => typeof id === 'string' && /^(?:shk|mhub|shrpc|shg1):[\w.:-]{1,150}$/.test(id) // a device this plugin reads
function arr24(a) {
  return Array.isArray(a) && a.length === 24
    ? a.map(num)
    : undefined
}

const BACKUP_RE = /^shelly-home-energy-\d{4}-\d\d-\d\d-\d{6}\.json$/
const KEEP_BACKUPS = 10
const backupDir = dataDir => path.join(dataDir, 'backups')
/** Backups saved by "Download a backup" on this computer, newest first. */
export function listBackups(dataDir) {
  const out = []
  try {
    for (const f of fs.readdirSync(backupDir(dataDir))) {
      if (BACKUP_RE.test(f)) {
        try {
          const st = fs.statSync(path.join(backupDir(dataDir), f))
          if (st.isFile()) {
            out.push({ name: f, size: st.size, modified: st.mtimeMs })
          }
        } catch {}
      }
    }
  } catch {}
  return out.sort((a, b) => b.name.localeCompare(a.name))
}
/** Write a backup into <data>/backups (keeping the newest 10) and return its name. */
export function saveBackup(dataDir, data, now = new Date()) {
  const p = n => String(n).padStart(2, '0')
  const name = `shelly-home-energy-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`
  privateDir(backupDir(dataDir))
  const file = path.join(backupDir(dataDir), name)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file) // household data: this account only
  for (const old of listBackups(dataDir).slice(KEEP_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(backupDir(dataDir), old.name))
    } catch {}
  }
  return name
}
/** Read one of the backups listBackups() lists (by its listed name only). */
export function readBackup(dataDir, name) {
  if (!listBackups(dataDir).some(f => f.name === name)) {
    throw new Error('That isn\'t one of the backups on this computer.')
  }
  return JSON.parse(fs.readFileSync(path.join(backupDir(dataDir), name), 'utf8'))
}

/** Restore a backup into the engine. Returns what came in (counts). */
export function importBackup(engine, d, { from = 'a backup file' } = {}) {
  if (!d || typeof d !== 'object' || d.format !== 'home-energy-1' || !Array.isArray(d.sigs)) {
    throw new Error('That isn\'t a backup made by this plugin.')
  }
  const E = engine
  // Matter devices
  const matter = new Map(E.matterDevices.filter(m => m.nodeId).map(m => [m.nodeId, m]))
  for (const h of Array.isArray(d.matterDevices)
    ? d.matterDevices
    : []) {
    const nodeId = String(h?.nodeId ?? '')
    if (!/^\d{1,20}$/.test(nodeId) || matter.has(nodeId)) {
      continue
    }
    const m = {
      id: `mtr-${uid()}`,
      name: str(h.name, 40) || 'Matter device',
      nodeId,
      product: str(h.product, 60),
      status: 'connecting',
      error: null,
    }
    matter.set(nodeId, m)
    E.matterDevices.push(m)
  }
  // appliances
  const sigs = d.sigs
    .filter(s => s && okId(s.id) && str(s.name, 60))
    .slice(0, 300)
    .map((s) => {
      const o = {
        id: s.id,
        name: str(s.name, 60),
        icon: cleanIcon(s.icon),
        room: str(s.room, 40),
        watts: num(s.watts),
        count: num(s.count),
        runs: num(s.runs),
        kwh: num(s.kwh),
        createdAt: num(s.createdAt) || Date.now(),
        lastSeen: num(s.lastSeen) || undefined,
        exposed: s.exposed !== false,
        stages: Array.isArray(s.stages)
          ? s.stages
              .filter(x => x && okId(x.id))
              .slice(0, 10)
              .map(x => ({
                id: x.id,
                watts: num(x.watts),
                count: num(x.count),
              }))
          : [],
        recentRuns: Array.isArray(s.recentRuns)
          ? s.recentRuns
              .map(num)
              .filter(x => x > 0)
              .slice(-20)
          : [],
        statusType: normStatusType(s.statusType, 'none'),
        statusCount: normStatusCount(s.statusCount),
        steadyOutlet: normSteady(s.steadyOutlet),
        steadyIdleMin: normIdleMin(s.steadyIdleMin),
      }
      if (s.relink === true) {
        o.relink = true
      }
      if (s.alertLong === true) {
        o.alertLong = true
      }
      if (Array.isArray(s.hours) && s.hours.length === 24) {
        o.hours = s.hours.map(x => Math.max(0, num(x)))
      }
      if (s.variable === true && !s.metered) {
        o.variable = true
      }
      if (s.metered && ownDevice(s.devId)) {
        Object.assign(o, { metered: true, devId: s.devId })
        if (Array.isArray(s.alsoDevs)) {
          const more = [
            ...new Set(s.alsoDevs.filter(x => ownDevice(x) && x !== s.devId)),
          ].slice(0, 7)
          if (more.length) {
            o.alsoDevs = more
          }
        }
        if (s.estimated) {
          o.estimated = true
          if (num(s.estW) > 0) {
            o.estW = num(s.estW)
          }
        } else {
          if (s.runW != null) {
            o.runW = num(s.runW)
          }
          if (s.finishMin != null) {
            o.finishMin = num(s.finishMin)
          }
          if (typeof s.runWSet === 'boolean') {
            o.runWSet = s.runWSet
          }
          if (typeof s.finishSet === 'boolean') {
            o.finishSet = s.finishSet
          }
          const L = s.learn
          if (L && typeof L === 'object') {
            o.learn = Object.fromEntries(
              [
                'runW',
                'finishSec',
                'standby',
                'cycles',
              ]
                .filter(k => L[k] !== null && Number.isFinite(+L[k]))
                .map(k => [
                  k,
                  num(L[k]),
                ]),
            )
          }
          // learned cycles (dishwasher / washing machine programmes) and the runs they come from
          if (Array.isArray(s.progs) && Array.isArray(s.cycles)) {
            o.progs = s.progs
              .filter(p => p && okId(p.id))
              .slice(0, 12)
              .map(p => ({ id: p.id, name: str(p.name, 40) || 'Cycle' }))
            const ids = new Set(o.progs.map(p => p.id))
            o.cycles = s.cycles
              .filter(c => c && okId(c.id) && ids.has(c.prog) && Array.isArray(c.prof))
              .slice(-40)
              .map(c => ({
                id: c.id,
                t: num(c.t),
                dur: num(c.dur),
                kwh: num(c.kwh),
                prog: c.prog,
                prof: c.prof.slice(0, 360).map(w => (w == null
                  ? null
                  : num(w))),
              }))
            o.progs = o.progs.filter(p => o.cycles.some(c => c.prog === p.id))
          }
        }
      }
      return o
    })
  const ids = new Set(sigs.map(s => s.id))
  E.sigs = [
    ...sigs,
    ...E.sigs.filter(
      s =>
        !ids.has(s.id)
        && !sigs.some(x => x.name.toLowerCase() === s.name.toLowerCase() && (x.room || '') === (s.room || '')),
    ),
  ]
  const all = new Set(E.sigs.map(s => s.id))
  // power steps (newest first), merged with any seen since
  const evs = (Array.isArray(d.events)
    ? d.events
    : [])
    .filter(e => e && okId(e.id) && num(e.t) > 0)
    .map(e => ({
      id: e.id,
      t: num(e.t),
      d: num(e.d),
      dir: e.dir === 'on'
        ? 'on'
        : 'off',
      sig: all.has(e.sig)
        ? e.sig
        : null,
      ...(e.dur
        ? {
            dur: num(e.dur),
          }
        : {}),
      ...(e.counted
        ? { counted: true }
        : {}),
      ...(okId(e.stage)
        ? { stage: e.stage, stageOn: e.stageOn === true }
        : {}),
      ...(all.has(e.also)
        ? { also: e.also }
        : {}),
      ...(okId(e.withStage)
        ? { withStage: e.withStage }
        : {}),
      ...(e.metered === true
        ? { metered: true }
        : {}),
      ...(e.run === true
        ? { run: true }
        : {}),
      ...(num(e.pf) > 0 && num(e.pf) <= 1
        ? {
            pf: num(e.pf),
          }
        : {}),
      ...(num(e.spike) > 0 && num(e.spike) < 100
        ? {
            spike: num(e.spike),
          }
        : {}),
    }))
  const seen = new Set()
  E.events = [
    ...evs,
    ...E.events,
  ]
    .filter(e => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.t - a.t)
    .slice(0, MAX_EVENTS)
  for (const s of sigs) {
    if (!s.recentRuns.length && !s.relink) {
      s.recentRuns = evs
        .filter(e => e.sig === s.id && e.dur > 0)
        .sort((a, b) => a.t - b.t)
        .map(e => e.dur)
        .slice(-20)
    }
  }
  // per-minute history (last 7 days): merged, one per minute
  const cutMin = Date.now() - 7 * 86400e3
  const mins = new Map([
    ...(Array.isArray(d.minutes)
      ? d.minutes
      : [])
      .filter(m => Array.isArray(m) && num(m[0]) > 0)
      .map(m => [
        num(m[0]),
        num(m[1]),
      ]),
    ...E.minutes.map(m => [m[0], m[1]]),
  ])
  E.minutes = [...mins].filter(([t]) => t >= cutMin).sort((a, b) => a[0] - b[0])
  // daily energy: both sides measured the same house, so a day both have keeps the fuller record (never added together)
  let days = 0
  for (const [k, v] of Object.entries(d.energy || {})) {
    if (!ymd(k) || !v || typeof v !== 'object') {
      continue
    }
    const x = {
      total: num(v.total),
      apps: {},
      other: num(v.other),
      peak: num(v.peak),
      peakT: num(v.peakT),
    }
    for (const [id, kwh] of Object.entries(v.apps || {})) {
      if (all.has(id)) {
        x.apps[id] = num(kwh)
      }
    }
    if (arr24(v.h)) {
      x.h = arr24(v.h)
    }
    if (arr24(v.oh)) {
      x.oh = arr24(v.oh)
    }
    if (v.ah && typeof v.ah === 'object') {
      x.ah = {}
      for (const [id, h] of Object.entries(v.ah)) {
        if (all.has(id) && arr24(h)) {
          x.ah[id] = arr24(h)
        }
      }
    }
    if (v.base != null) {
      x.base = num(v.base)
    }
    if ((E.energy[k]?.total || 0) > x.total) {
      continue
    }
    E.energy[k] = x
    days++
  }
  E.pruneDays()
  // running appliances, last stop times, lifetime Other (Apple Home's energy total must never go down)
  for (const [k, v] of Object.entries(d.running || {})) {
    if (all.has(k) && num(v) > Date.now() - 12 * 3600e3 && !E.sigById(k)?.metered) {
      E.running[k] = num(v)
    }
  }
  for (const [k, v] of Object.entries(d.lastOffAt || {})) {
    if (all.has(k)) {
      E.lastOffAt[k] = num(v)
    }
  }
  E.otherKwh = Math.max(E.otherKwh, num(d.otherKwh))
  // outlets refreshed in Apple Home: keep the newest identity of each (the same outlets as before the backup)
  for (const [id, g] of Object.entries(d.matterGen && typeof d.matterGen === 'object'
    ? d.matterGen
    : {})) {
    if ((all.has(id) || id === '__other__') && Number.isInteger(g) && g > 0 && g < 1e6) {
      E.matterGen[id] = Math.max(E.matterGen[id] || 0, g)
    }
  }
  // watts learned from switching, and recent switches
  for (const [id, x] of Object.entries(d.devEst || {})) {
    if (!ownDevice(id) || !x || E.devEst[id] || !Array.isArray(x.ws)) {
      continue
    }
    E.devEst[id] = {
      ws: x.ws
        .map(num)
        .filter(w => w > 0)
        .slice(-15),
      n: num(x.n),
      skip: num(x.skip),
      small: num(x.small),
      t: num(x.t),
    }
  }
  const devEvs = (Array.isArray(d.devEvents)
    ? d.devEvents
    : [])
    .filter(h => h && ownDevice(h.id) && typeof h.on === 'boolean')
    .map(h => ({
      id: h.id,
      name: str(h.name, 80),
      on: h.on,
      t: num(h.t),
      after: num(h.after) || num(h.t),
    }))
  const seenDev = new Set()
  E.devEvents = [
    ...E.devEvents,
    ...devEvs,
  ]
    .filter((h) => {
      const k = `${h.id}|${h.t}|${h.on}`
      return !seenDev.has(k) && seenDev.add(k)
    })
    .sort((a, b) => b.t - a.t)
    .slice(0, 2000)
  // settings (never the web page's PIN or sign-ins)
  const S = d.settings || {}
  const T = E.settings
  if (S.threshold != null) {
    T.threshold = Math.min(2000, Math.max(10, Math.round(+S.threshold) || 40))
  }
  if (S.currency) {
    T.currency = str(S.currency, 4) || '$'
  }
  if (!(T.tariff.rate > 0 || T.tariff.periods.length) && S.tariff) {
    T.tariff = cleanTariff(S.tariff)
  }
  if (S.cheapTile === true && T.tariff.mode === 'tou' && T.tariff.periods.length) {
    T.cheapTile = true
  }
  if (!T.budget && +S.budget > 0 && +S.budget <= 1e6) {
    T.budget = +S.budget
    if (S.budgetTile === true) {
      T.budgetTile = true
    }
  }
  if ((T.billDay || 1) === 1 && +S.billDay > 1 && +S.billDay <= 28) {
    T.billDay = Math.round(+S.billDay)
  }
  T.rooms = [
    ...new Set([
      ...T.rooms,
      ...(Array.isArray(S.rooms)
        ? S.rooms.map(r => str(r, 40)).filter(Boolean)
        : []),
    ]),
  ].slice(0, 100)
  if (S.roomsOrdered === true && !T.roomsOrdered) {
    T.rooms = [
      ...new Set([
        ...(S.rooms || []).map(r => str(r, 40)).filter(r => T.rooms.includes(r)),
        ...T.rooms,
      ]),
    ]
    T.roomsOrdered = true
  }
  T.shellyHosts = hostList([
    ...T.shellyHosts,
    ...(Array.isArray(S.shellyHosts)
      ? S.shellyHosts
      : []),
  ])
  if (S.em?.host && !T.em.host) {
    const h = hostList([S.em.host])[0]
    if (h) {
      T.em = {
        host: h,
        channel: EM_CHANNEL.test(S.em.channel)
          ? S.em.channel
          : 'auto',
      }
      E.emit('em')
    }
  }
  if (S.other && typeof S.other === 'object') {
    T.other = { on: S.other.on !== false, name: str(S.other.name, 32) || 'Other appliances' }
  }
  if (Array.isArray(S.dismissed)) {
    T.dismissed = [
      ...T.dismissed,
      ...S.dismissed.filter(x => x?.name).map(x => ({
        name: str(x.name, 60),
        w: num(x.w),
      })),
    ].slice(-200)
  }
  if (Array.isArray(S.devHidden)) {
    T.devHidden = [
      ...new Set([
        ...T.devHidden,
        ...S.devHidden.filter(ownDevice),
      ]),
    ].slice(-500)
  }
  if (S.tipsDismissed && typeof S.tipsDismissed === 'object') {
    for (const [k, v] of Object.entries(S.tipsDismissed).slice(0, 300)) {
      if (k.length <= 80 && Number.isFinite(+v)) {
        T.tipsDismissed[k] = +v
      }
    }
  }
  for (const s of E.sigs) E.noteRoom(s.room)
  const counts = {
    appliances: sigs.length,
    steps: evs.length,
    days,
    matter: matter.size,
    tracked: sigs.filter(s => s.metered).length,
  }
  E.imported = {
    at: Date.now(),
    from: str(from, 80),
    counts,
  }
  E.changed()
  E.emit('sigs')
  E.emit('shellyHosts')
  E.emit('tiles')
  E.matterPublish()
  E.save()
  return E.imported
}
