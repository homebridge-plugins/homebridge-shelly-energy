// Shellys on the home network, read by address. Three kinds, recognised automatically per address:
//  - the open HomeKit firmware (github.com/mongoose-os-apps/shelly-homekit): GET /rpc/Shelly.GetInfoExt
//    (relay state, and apower on models that measure).
//  - Shelly Gen2/Gen3/Gen4 stock firmware (also when paired to Apple Home over Matter): Shelly.GetDeviceInfo once,
//    Shelly.GetConfig for names, Shelly.GetStatus every poll. Read: switch (output + apower), pm1 (meter), cover (apower),
//    light / rgb / rgbw / cct / rgbcct (output + apower), em1 (act_power, one clamp) and em (total_act_power, 3-phase).
//  - Gen1 stock firmware (the original Shelly 1PM, 2.5, Plug S, Dimmer, EM, 3EM): GET /shelly (no "gen"), /settings for names,
//    /status every poll: relays[].ison with meters[].power, lights[], rollers[].power, emeters[].power.
// Gen2+ also get a live connection (WebSocket to ws://<address>/rpc, Shelly's own RPC channel): the device pushes each change
// (NotifyStatus) the moment it happens, so switches are timed to the second and there's no reading every 3 s. A status request
// over it every minute catches a dead connection; while it's down, or on firmware without it, the 3 s reading takes over.
// Read-only: this plugin never switches them. No passwords: a Shelly with authentication on is reported as such.
// isMain(host, key): the clamp used as the whole-house meter is never also offered as a device.
import { hostList } from './hosts.js'
import { getDevice } from './net.js'

const POLL = 3000
const TIMEOUT = 2500
const DROP_AFTER = 60e3
const CONFIG_EVERY = 10 * 60e3
const REDETECT_AFTER = 10
const LIVE_CHECK = 60e3
const LIVE_REPLY = 15e3
const LIVE_RETRY = [5e3, 15e3, 60e3, 300e3]
const FRESH = 15e3
const MAX_MSG = 1024 * 1024
const HK_TYPES = { 0: 'Switch', 1: 'Outlet', 3: 'Valve' }
const r1 = v => Math.round(v * 10) / 10

/** HomeKit firmware: one device's GetInfoExt -> devices (relays only). */
export function hkDevices(info, host) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.components)) {
    return []
  }
  const dev = String(info.device_id || host).slice(0, 60)
  const out = []
  for (const c of info.components) {
    if (!c || typeof c !== 'object' || typeof c.state !== 'boolean') {
      continue
    }
    const values = { On: c.state }
    const w = c.apower ?? c.power
    if (typeof w === 'number' && Number.isFinite(w)) {
      values.Watts = r1(w)
    }
    out.push({
      id: `shk:${dev}:${c.id}`,
      name: String(c.name || info.name || dev).slice(0, 80),
      type: HK_TYPES[c.svc_type] || 'Switch',
      values,
      on: c.state,
      protocol: 'shelly',
      model: String(info.model || '').slice(0, 60),
      host,
      reachable: true,
    })
  }
  return out
}
/** Gen2+ stock firmware: GetDeviceInfo + GetConfig + GetStatus -> devices. */
const RPC_PARTS = {
  switch: 'Outlet',
  pm1: 'PowerMeter',
  cover: 'WindowCovering',
  light: 'Lightbulb',
  rgb: 'Lightbulb',
  rgbw: 'Lightbulb',
  cct: 'Lightbulb',
  rgbcct: 'Lightbulb',
  em1: 'PowerMeter',
  em: 'PowerMeter',
}
function rpcId(kind, n) {
  return kind === 'switch'
    ? `${n}`
    : kind === 'pm1'
      ? `pm${n}`
      : kind === 'em1'
        ? `em1-${n}`
        : kind === 'em'
          ? `em-${n}`
          : `${kind}${n}`
} // switch and pm1 ids are the ones 2.0 used
export function rpcDevices(info, config, status, host, isMain = () => false) {
  if (!info || !status || typeof status !== 'object') {
    return []
  }
  const dev = String(info.id || info.mac || host).slice(0, 60)
  const out = []
  const devName = String(info.name || config?.sys?.device?.name || '').trim()
  const base = devName || String(info.app || info.model || 'Shelly')
  for (const [k, v] of Object.entries(status)) {
    const m = /^(switch|pm1|cover|light|rgb|rgbw|cct|rgbcct|em1|em):(\d+)$/.exec(k)
    if (!m || !v || typeof v !== 'object' || isMain(host, k)) {
      continue
    }
    const [, kind] = m
    const n = +m[2]
    const cname = String(config?.[k]?.name || '').trim()
    const values = {}
    const w = kind === 'em'
      ? v.total_act_power
      : kind === 'em1'
        ? v.act_power
        : v.apower
    if (typeof w === 'number' && Number.isFinite(w)) {
      values.Watts = r1(w)
    }
    const on = typeof v.output === 'boolean'
      ? v.output
      : undefined
    if (on !== undefined) {
      values.On = on
    }
    if (on === undefined && values.Watts === undefined) {
      continue
    }
    const name
      = cname
        || (kind === 'em'
          ? `${base} total`
          : kind === 'em1'
            ? `${base} clamp ${n + 1}`
            : n
              ? `${base} ${n + 1}`
              : devName || `${base} ${n + 1}`)
    out.push({
      id: `shrpc:${dev}:${rpcId(kind, n)}`,
      name: name.slice(0, 80),
      type: kind === 'switch' && on === undefined
        ? 'PowerMeter'
        : RPC_PARTS[kind],
      values,
      on,
      protocol: 'shelly',
      model: String(info.model || info.app || '').slice(0, 60),
      host,
      reachable: true,
    })
  }
  return out
}

/** Gen1 stock firmware: /shelly + /settings + /status -> devices. */
export function gen1Devices(info, settings, status, host, isMain = () => false) {
  if (!info || !status || typeof status !== 'object') {
    return []
  }
  const dev = String(info.mac || host)
    .toLowerCase()
    .slice(0, 60)
  const out = []
  const devName = String(settings?.name || '').trim()
  const base = devName || String(info.type || 'Shelly')
  const meter = (i) => {
    const m = status.meters?.[i]
    return m && m.is_valid !== false && typeof m.power === 'number'
      ? r1(m.power)
      : undefined
  }
  const push = (kind, i, type, on, watts, sname) => {
    if (isMain(host, `${kind}:${i}`)) {
      return
    }
    const values = {}
    if (watts !== undefined) {
      values.Watts = watts
    }
    if (on !== undefined) {
      values.On = on
    }
    if (on === undefined && watts === undefined) {
      return
    }
    const name
      = String(sname || '').trim()
        || (i || (kind !== 'relay' && kind !== 'light')
          ? `${base} ${kind === 'emeter'
            ? 'clamp '
            : ''}${i + 1}`
          : base)
    out.push({
      id: `shg1:${dev}:${kind}${i}`,
      name: name.slice(0, 80),
      type,
      values,
      on,
      protocol: 'shelly',
      model: String(info.type || '').slice(0, 60),
      host,
      reachable: true,
    })
  }
  const rollers = Array.isArray(status.rollers)
    ? status.rollers
    : []
  if (rollers.length) {
    rollers.forEach((r, i) =>
      push(
        'roller',
        i,
        'WindowCovering',
        undefined,
        typeof r?.power === 'number'
          ? r1(r.power)
          : meter(i),
        settings?.rollers?.[i]?.name,
      ),
    )
  } else {
    ;(status.relays || []).forEach((r, i) =>
      push(
        'relay',
        i,
        'Outlet',
        typeof r?.ison === 'boolean'
          ? r.ison
          : undefined,
        status.emeters?.length
          ? undefined
          : meter(i),
        settings?.relays?.[i]?.name,
      ),
    )
  }
  ;(status.lights || []).forEach((l, i) =>
    push(
      'light',
      i,
      'Lightbulb',
      typeof l?.ison === 'boolean'
        ? l.ison
        : undefined,
      typeof l?.power === 'number'
        ? r1(l.power)
        : meter(i),
      settings?.lights?.[i]?.name,
    ),
  )
  ;(status.emeters || []).forEach((m, i) =>
    push(
      'emeter',
      i,
      'PowerMeter',
      undefined,
      m && m.is_valid !== false && typeof m.power === 'number'
        ? r1(m.power)
        : undefined,
      settings?.emeters?.[i]?.name,
    ),
  )
  // meters beyond the relays and lights (a device that only measures)
  // (in roller mode a 2.5's two meters are the shutter's two directions: already in the roller's power)
  const used = rollers.length
    ? Infinity
    : Math.max((status.relays || []).length, (status.lights || []).length)
  for (let i = used; i < (status.meters || []).length; i++) push('meter', i, 'PowerMeter', undefined, meter(i), null)
  return out
}

export class ShellyDevices {
  constructor({
    log,
    hosts = [],
    onChange,
    fetchImpl = fetch,
    isMain = () => false,
    WebSocketImpl = globalThis.WebSocket,
    live = true,
    timing = {},
  }) {
    this.T = {
      check: LIVE_CHECK,
      reply: LIVE_REPLY,
      retry: LIVE_RETRY,
      fresh: FRESH,
      ...timing,
    } // the tests shorten these
    this.log = log
    this.onChange = onChange
    this.fetch = fetchImpl
    this.isMain = isMain
    this.WS = live ? WebSocketImpl : null
    this.src = `shelly-home-energy-${Math.random().toString(36).slice(2, 10)}` // how this plugin names itself to the devices
    this.devs = new Map()
    this.timer = null
    this.sig = ''
    this.setHosts(hosts)
  }

  setHosts(hosts) {
    const want = hostList(hosts)
    for (const h of [
      ...this.devs.keys(),
    ]) {
      if (!want.includes(h)) {
        this.closeLive(this.devs.get(h))
        this.devs.delete(h)
      }
    }
    for (const h of want) {
      if (!this.devs.has(h)) {
        this.devs.set(h, {
          host: h,
          kind: null,
          list: [],
          ok: null,
          msg: 'Checking…',
          seen: 0,
          busy: false,
          fails: 0,
        })
      }
    }
    this.changed()
    if (this.timer) {
      this.pollAll()
    }
  }

  start() {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.pollAll(), this.T.poll || POLL)
    this.pollAll()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    for (const d of this.devs.values()) this.closeLive(d)
  }

  list() {
    return [
      ...this.devs.values(),
    ].flatMap(d => d.list)
  }

  status() {
    return [
      ...this.devs.values(),
    ].map(d => ({
      host: d.host,
      ok: d.ok,
      msg: d.msg,
      name: d.name || '',
      model: d.model || '',
      kind: d.kind,
      count: d.list.length,
      seen: d.seen,
      live: !!d.live?.up,
    }))
  }

  // passes the readings on when anything changed, and at least every 15 s (so a steady load on a live connection, which sends
  // nothing while it doesn't change, still counts as a fresh reading)
  changed() {
    const sig = JSON.stringify([
      this.list(),
      this.status().map(s => [
        s.host,
        s.ok,
        s.msg,
        s.name,
        s.kind,
        s.live,
      ]),
    ])
    if (sig !== this.sig || Date.now() - (this.sentAt || 0) >= this.T.fresh) {
      this.sig = sig
      this.sentAt = Date.now()
      this.onChange?.()
    }
  }

  // ---------- live connection (Gen2+) ----------
  openLive(d) {
    if (!this.WS || d.kind !== 'rpc' || d.live || Date.now() < (d.liveRetryAt || 0)) {
      return
    }
    let sock
    try {
      sock = new this.WS(`ws://${d.host}/rpc`)
    } catch {
      return this.liveFailed(d)
    }
    const L = (d.live = {
      sock,
      up: false,
      id: 0,
      asked: 0,
      answered: 0,
    })
    const ask = () => {
      L.asked = Date.now()
      L.waitId = ++L.id
      try {
        sock.send(JSON.stringify({ id: L.waitId, src: this.src, method: 'Shelly.GetStatus' }))
      } catch {}
    }
    L.ask = ask
    sock.onopen = ask // a request with our name is also what makes the device start pushing changes to us
    sock.onmessage = (ev) => {
      if (d.live !== L) {
        return
      }
      const text = typeof ev.data === 'string'
        ? ev.data
        : ''
      if (!text || text.length > MAX_MSG) {
        return
      }
      let m
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (!m || typeof m !== 'object') {
        return
      }
      if (m.id === L.waitId && m.result && typeof m.result === 'object') {
        d.status = m.result
        L.answered = Date.now()
      } else if (
        (m.method === 'NotifyStatus' || m.method === 'NotifyFullStatus')
        && m.params
        && typeof m.params === 'object'
        && d.status
      ) {
        for (const [k, v] of Object.entries(m.params)) {
          if (k !== 'ts' && v && typeof v === 'object') {
            d.status[k] = m.method === 'NotifyFullStatus'
              ? v
              : {
                  ...(d.status[k] || {}),
                  ...v,
                }
          }
        }
      } else {
        return
      }
      if (!L.up) {
        L.up = true
        d.liveFails = 0
        this.log?.debug?.(`Shelly ${d.host}: live connection open.`)
      }
      d.list = rpcDevices(d.info, d.config, d.status, d.host, this.isMain).map(a => ({ ...a, live: true }))
      d.ok = true
      d.seen = Date.now()
      d.fails = 0
      d.msg = d.list.length
        ? `${d.list.length} channel${d.list.length === 1
          ? ''
          : 's'}`
        : 'No relays or power meters on it'
      this.changed()
    }
    sock.onclose = sock.onerror = () => {
      if (d.live === L) {
        d.live = null
        this.liveFailed(d)
        this.changed()
      }
    }
  }

  liveFailed(d) {
    d.liveFails = (d.liveFails || 0) + 1
    d.liveRetryAt = Date.now() + this.T.retry[Math.min(d.liveFails - 1, this.T.retry.length - 1)]
  }

  closeLive(d) {
    const L = d?.live
    if (!L) {
      return
    }
    d.live = null
    try {
      L.sock.onclose = L.sock.onerror = L.sock.onmessage = null
      L.sock.close()
    } catch {}
  }

  rpc(host, method) {
    return this.get(host, `rpc/${method}`)
  }

  async get(host, path) {
    const r = await getDevice(this.fetch, host, path, { timeout: TIMEOUT })
    const j = r.json
    if (r.status === 401) {
      const e = new Error(
        'This Shelly has a password set (device authentication). Turn it off in the Shelly app to read it here.',
      )
      e.auth = true
      throw e
    }
    if (r.status === 404 || (j && j.code === 404)) {
      const e = new Error('not found')
      e.notFound = true
      throw e
    }
    if (!r.ok || (j && typeof j === 'object' && j.code && j.message)) {
      throw new Error(j?.message
        ? `The Shelly said: ${String(j.message).slice(0, 120)}`
        : `HTTP ${r.status}`)
    }
    return j
  }

  async pollAll() {
    await Promise.all([
      ...this.devs.values(),
    ].map(d => this.poll(d)))
    this.changed()
  }

  // which firmware: the HomeKit firmware answers GetInfoExt; every stock Shelly answers /shelly, Gen2+ with a "gen" number
  async detect(d) {
    try {
      const info = await this.rpc(d.host, 'Shelly.GetInfoExt')
      if (info && Array.isArray(info.components)) {
        d.kind = 'homekit'
        return info
      }
    } catch (e) {
      if (e.auth || !e.notFound) {
        throw e
      }
    }
    const id = await this.get(d.host, 'shelly')
    if (id && id.gen >= 2) {
      d.kind = 'rpc'
      d.info = await this.rpc(d.host, 'Shelly.GetDeviceInfo')
      d.configAt = 0
      return null
    }
    if (id && typeof id.type === 'string' && id.mac) {
      if (id.auth === true) {
        const e = new Error(
          'This Shelly has a password set (restricted login). Turn it off in the Shelly app to read it here.',
        )
        e.auth = true
        throw e
      }
      d.kind = 'gen1'
      d.info = id
      d.configAt = 0
      return null
    }
    throw new Error('That address answered, but not like a Shelly.')
  }

  async poll(d) {
    if (d.busy) {
      return
    }
    // on a live connection: nothing to read; check it's still there once a minute, and refresh names every 10 minutes
    const L = d.live
    if (L?.up) {
      if (L.asked > L.answered && Date.now() - L.asked > this.T.reply) {
        this.log?.debug?.(`Shelly ${d.host}: live connection stopped answering.`)
        this.closeLive(d)
        this.liveFailed(d)
      } else {
        if (Date.now() - L.asked >= this.T.check) {
          L.ask()
        }
        if (Date.now() - (d.configAt || 0) > CONFIG_EVERY) {
          d.configAt = Date.now()
          this.rpc(d.host, 'Shelly.GetConfig')
            .then((c) => {
              d.config = c
            })
            .catch(() => {})
        }
        return
      }
    }
    d.busy = true
    try {
      let hkInfo = null
      if (!d.kind) {
        hkInfo = await this.detect(d)
      }
      if (d.kind === 'homekit') {
        const info = hkInfo || (await this.rpc(d.host, 'Shelly.GetInfoExt'))
        if (!info || !Array.isArray(info.components)) {
          throw new Error('That address answered, but not like a Shelly with the HomeKit firmware.')
        }
        d.list = hkDevices(info, d.host)
        d.name = String(info.name || '').slice(0, 80)
        d.model = String(info.model || '').slice(0, 40)
      } else if (d.kind === 'gen1') {
        if (Date.now() - (d.configAt || 0) > CONFIG_EVERY) {
          try {
            d.config = await this.get(d.host, 'settings')
          } catch {
            d.config ??= null
          }
          d.configAt = Date.now()
        }
        const st = await this.get(d.host, 'status')
        d.list = gen1Devices(d.info, d.config, st, d.host, this.isMain)
        d.name = String(d.config?.name || '').slice(0, 80)
        d.model = String(d.info.type || '').slice(0, 40)
      } else {
        if (Date.now() - (d.configAt || 0) > CONFIG_EVERY) {
          try {
            d.config = await this.rpc(d.host, 'Shelly.GetConfig')
          } catch {
            d.config ??= null
          }
          d.configAt = Date.now()
        }
        const st = await this.rpc(d.host, 'Shelly.GetStatus')
        d.status = st
        d.list = rpcDevices(d.info, d.config, st, d.host, this.isMain)
        d.name = String(d.info.name || d.config?.sys?.device?.name || '').slice(0, 80)
        d.model = String(d.info.model || '').slice(0, 40)
      }
      if (d.ok === false && d.fails >= 5) {
        this.log?.info?.(`Shelly ${d.host} is connected again.`)
      }
      d.ok = true
      d.msg = d.list.length
        ? `${d.list.length} channel${d.list.length === 1
          ? ''
          : 's'}`
        : 'No relays or power meters on it'
      d.seen = Date.now()
      d.fails = 0
      if (d.kind === 'rpc') {
        this.openLive(d)
      } // from now on the device pushes its changes
    } catch (e) {
      d.fails++
      const code = e?.cause?.code || e?.code
      d.msg
        = e?.name === 'TimeoutError'
          ? 'Didn\'t answer in time'
          : [
              'ECONNREFUSED',
              'EHOSTUNREACH',
              'ENOTFOUND',
              'ENETUNREACH',
              'EHOSTDOWN',
            ].includes(code)
            || /fetch failed/.test(e?.message)
              ? 'Couldn\'t reach it'
              : String(e?.message || e).slice(0, 160)
      d.ok = false
      if (!d.seen || Date.now() - d.seen > DROP_AFTER) {
        d.list = d.list.map(a => ({
          ...a,
          reachable: false,
          on: undefined,
          values: {},
        }))
      } // gone a minute: no stale state
      if (d.fails >= REDETECT_AFTER && d.fails % REDETECT_AFTER === 0) {
        d.kind = null
      } // maybe it was replaced or re-flashed
      if (d.fails === 5) {
        this.log?.warn?.(`Shelly ${d.host}: ${d.msg}. Still trying every few seconds.`)
      }
    } finally {
      d.busy = false
    }
  }
}
