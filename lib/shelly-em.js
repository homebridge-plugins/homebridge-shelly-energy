// The whole-house meter: a Shelly EM (Gen3/Gen4, EM Mini Gen4: em1:N), Pro EM, Pro 3EM / 3EM-63 (em:N) or any metered Shelly,
// read over its local RPC API; or a Gen1 Shelly EM / 3EM (emeters[] in /status).
import { getDevice } from './net.js'

// reactive power (VAR, unsigned) from real and apparent power; null when the meter doesn't give apparent power
function reactive(p, s) {
  return typeof s === 'number' && Number.isFinite(s) && Math.abs(s) >= Math.abs(p)
    ? Math.sqrt(s * s - p * p)
    : null
}
function whOf(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0
    ? x
    : null
}
// wh: the meter's own running count of energy drawn from the grid (Wh), used to fill gaps and to check the plugin's sums.
// em1:N's count is in em1data:N, em:N's in emdata:N; plugs and relays carry theirs in aenergy.total.
export function parseChannels(st) {
  const out = []
  for (const [k, v] of Object.entries(st || {})) {
    if (!v || typeof v !== 'object') {
      continue
    }
    const n = k.split(':')[1]
    if (k.startsWith('em1:') && typeof v.act_power === 'number') {
      out.push({
        key: k,
        label: `CT clamp ${+n + 1}`,
        p: v.act_power,
        q: reactive(v.act_power, v.aprt_power),
        wh: whOf(st[`em1data:${n}`]?.total_act_energy),
      })
    } else if (k.startsWith('em:') && typeof v.total_act_power === 'number') {
      out.push({
        key: k,
        label: '3-phase total',
        p: v.total_act_power,
        q: reactive(v.total_act_power, v.total_aprt_power),
        wh: whOf(st[`emdata:${n}`]?.total_act),
      })
    } else if ((k.startsWith('pm1:') || k.startsWith('switch:')) && typeof v.apower === 'number') {
      out.push({
        key: k,
        label: k,
        p: v.apower,
        wh: whOf(v.aenergy?.total),
      })
    }
  }
  return out
}

// Gen1: emeters (EM: two clamps; 3EM: three phases) and meters
export function parseGen1(st) {
  const out = []
  const em = Array.isArray(st?.emeters)
    ? st.emeters
    : []
  em.forEach((v, i) => {
    if (v && v.is_valid !== false && typeof v.power === 'number') {
      out.push({
        key: `emeter:${i}`,
        label: em.length === 3
          ? `Phase ${'ABC'[i]}`
          : `CT clamp ${i + 1}`,
        p: v.power,
        q: typeof v.reactive === 'number'
          ? Math.abs(v.reactive)
          : null,
        wh: whOf(v.total),
      })
    }
  })
  // Gen1 plugs and relays count in watt-minutes
  ;(Array.isArray(st?.meters)
    ? st.meters
    : []).forEach((v, i) => {
    if (v && v.is_valid !== false && typeof v.power === 'number') {
      out.push({
        key: `meter:${i}`,
        label: `Meter ${i + 1}`,
        p: v.power,
        wh: whOf(v.total) != null
          ? v.total / 60
          : null,
      })
    }
  })
  return out
}
const gen1Hosts = new Set() // addresses that answered like a Gen1 Shelly: read /status straight away
async function readShelly(host, channel = 'auto', fetchImpl = fetch) {
  const get = path => getDevice(fetchImpl, host, path, { timeout: 3000 })
  let r = await get(gen1Hosts.has(host)
    ? 'status'
    : 'rpc/Shelly.GetStatus')
  let chs
  if (r.status === 404 && !gen1Hosts.has(host)) {
    r = await get('status')
    if (r.ok) {
      gen1Hosts.add(host)
    }
  }
  if (r.status === 401) {
    throw new Error(
      'the Shelly has a password set. Turn off device authentication in the Shelly app, or give the plugin a meter without one',
    )
  }
  if (!r.ok) {
    throw new Error(`the Shelly replied HTTP ${r.status}`)
  }
  if (gen1Hosts.has(host)) {
    chs = parseGen1(r.json)
    if (chs.length > 1 && channel === 'auto' && chs.filter(c => c.key.startsWith('emeter:')).length === 3) {
      channel = 'sum'
    }
  } else {
    chs = parseChannels(r.json)
  }
  return {
    ...pick(chs, channel),
    gen1: gen1Hosts.has(host),
    status: gen1Hosts.has(host)
      ? null
      : r.json,
  }
}
// the whole-house reading from the channels: the chosen clamp, or all of them added up
function pick(chs, channel) {
  if (!chs.length) {
    throw new Error('no power meter found in the Shelly\'s status. Is this the Shelly EM\'s address?')
  }
  let sel = channel === 'sum'
    ? chs
    : chs.filter(c => c.key === channel)
  if (!sel.length) {
    sel = [chs[0]]
  }
  const p = sel.reduce((s, c) => s + c.p, 0)
  const q = sel.every(c => c.q != null)
    ? sel.reduce((s, c) => s + c.q, 0)
    : null
  const wh = sel.every(c => c.wh != null)
    ? sel.reduce((s, c) => s + c.wh, 0)
    : null
  return {
    p,
    q,
    wh,
    key: sel.length === 1
      ? sel[0].key
      : 'sum',
    channels: chs.map(c => ({ key: c.key, label: c.label, p: c.p })),
  }
}

// A reading every second, never two requests at once; a clear status, and a log line at most every 5 minutes while down.
// A Gen2+ meter also gets a live connection (WebSocket to ws://<address>/rpc): it pushes each change (NotifyStatus), and the
// reading passed on each second comes from that instead of a new request. A full status is also asked over it each second (for
// reactive power, which pushes don't carry with each watts change); nothing
// heard for 10 s: closed, and the plain once-a-second reading takes over until it reconnects (5 s, 15 s, 60 s, then 5 min).
// While the meter can't be reached: tried again after 2 s, 5 s, then every 10 s, and every second again once it answers.
const LIVE_ASK = 1000
const LIVE_DEAD = 10e3
const LIVE_RETRY = [5e3, 15e3, 60e3, 300e3]
const MAX_MSG = 1024 * 1024
const DOWN_RETRY = [2e3, 5e3, 10e3]
export class EmPoller {
  constructor({
    log,
    onSample,
    onStatus = () => {},
    fetchImpl = fetch,
    interval = 1000,
    WebSocketImpl = globalThis.WebSocket,
    live = true,
    timing = {},
  }) {
    this.T = {
      ask: LIVE_ASK,
      dead: LIVE_DEAD,
      retry: LIVE_RETRY,
      down: DOWN_RETRY,
      ...timing,
    } // the tests shorten these
    this.log = log
    this.onSample = onSample
    this.onStatus = onStatus
    this.fetch = fetchImpl
    this.interval = interval
    this.WS = live ? WebSocketImpl : null
    this.src = `shelly-home-energy-em-${Math.random().toString(36).slice(2, 8)}`
    this.host = ''
    this.channel = 'auto'
    this.timer = null
    this.busy = false
    this.errorLogged = 0
    this.wasDown = false
    this.status = { ok: false, msg: 'Not set up: add the Shelly EM\'s address.' }
  }

  set(host, channel) {
    const changed = host !== this.host || channel !== this.channel
    this.host = host || ''
    this.channel = channel || 'auto'
    if (changed) {
      this.closeLive()
      this.liveFails = 0
      this.downFails = 0
      this.downUntil = 0
      this.liveRetryAt = 0
      this.errorLogged = 0
      this.setStatus(
        this.host
          ? { ok: false, msg: 'Connecting…' }
          : { ok: false, msg: 'Not set up: add the Shelly EM\'s address.' },
      )
      if (this.host) {
        this.log.info(`Reading whole-house power from the Shelly EM at ${this.host}`)
      }
    }
  }

  setStatus(s) {
    this.status = s
    this.onStatus(s)
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.interval)
    }
    this.poll()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.closeLive()
  }

  // ---------- live connection (Gen2+ meters) ----------
  openLive(status) {
    if (!this.WS || this.live || Date.now() < (this.liveRetryAt || 0)) {
      return
    }
    let sock
    try {
      sock = new this.WS(`ws://${this.host}/rpc`)
    } catch {
      return this.liveFailed()
    }
    const L = (this.live = {
      sock,
      host: this.host,
      up: false,
      status: structuredClone(status || {}),
      id: 0,
      asked: 0,
      heard: Date.now(),
    })
    L.ask = () => {
      L.asked = Date.now()
      try {
        sock.send(JSON.stringify({ id: ++L.id, src: this.src, method: 'Shelly.GetStatus' }))
      } catch {}
    }
    sock.onopen = L.ask // a request with our name is also what makes the meter start pushing to us
    sock.onmessage = (ev) => {
      if (this.live !== L) {
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
      if (m?.result && typeof m.result === 'object' && m.id) {
        L.status = m.result
        L.full = m.result // full: watts and apparent power together
      } else if (
        (m?.method === 'NotifyStatus' || m?.method === 'NotifyFullStatus')
        && m.params
        && typeof m.params === 'object'
      ) {
        for (const [k, v] of Object.entries(m.params)) {
          if (k !== 'ts' && v && typeof v === 'object') {
            L.status[k] = m.method === 'NotifyFullStatus'
              ? v
              : {
                  ...(L.status[k] || {}),
                  ...v,
                }
          }
        }
      } else {
        return
      }
      L.heard = Date.now()
      if (!L.up) {
        L.up = true
        this.liveFails = 0
        this.log.debug?.(`Shelly EM at ${L.host}: live connection open.`)
      }
    }
    sock.onclose = sock.onerror = () => {
      if (this.live === L) {
        this.live = null
        this.liveFailed()
      }
    }
  }

  liveFailed() {
    this.liveFails = (this.liveFails || 0) + 1
    this.liveRetryAt = Date.now() + this.T.retry[Math.min(this.liveFails - 1, this.T.retry.length - 1)]
  }

  closeLive() {
    const L = this.live
    if (!L) {
      return
    }
    this.live = null
    try {
      L.sock.onclose = L.sock.onerror = L.sock.onmessage = null
      L.sock.close()
    } catch {}
  }

  // a reading from the live connection, or null when it isn't up (or has gone quiet too long)
  liveReading() {
    const L = this.live
    if (!L?.up || L.host !== this.host) {
      return null
    }
    const quiet = Date.now() - L.heard
    if (quiet > this.T.dead) {
      this.log.debug?.(`Shelly EM at ${L.host}: live connection went quiet.`)
      this.closeLive()
      this.liveFailed()
      return null
    }
    if (Date.now() - L.asked > this.T.ask) {
      L.ask()
    } // a full status each second too: reactive power with its own watts
    try {
      const r = pick(parseChannels(L.status), this.channel)
      const f = L.full
        ? pick(parseChannels(L.full), this.channel)
        : null
      return {
        ...r,
        q: f?.q ?? null,
        wh: f?.wh ?? r.wh ?? null,
        live: true,
      }
    } catch {
      return null
    }
  }

  async poll() {
    if (this.busy || !this.host || Date.now() < (this.downUntil || 0)) {
      return
    }
    this.busy = true
    const host = this.host
    try {
      const r = this.liveReading() || (await readShelly(host, this.channel, this.fetch))
      if (host !== this.host) {
        return
      }
      if (!r.live && !r.gen1) {
        this.openLive(r.status)
      }
      this.downFails = 0
      this.downUntil = 0
      this.onSample(Date.now(), r.p, r.q, r.wh ?? null)
      this.keys = r.key === 'sum'
        ? r.channels.map(c => c.key)
        : [r.key]
      const label = r.channels.find(c => c.key === r.key)?.label || (r.key === 'sum'
        ? 'all clamps'
        : r.key)
      const msg = `${r.live ? 'Live connection' : 'Read every second'} (${label})`
      if (!this.status.ok || this.status.msg !== msg || this.status.channels?.length !== r.channels.length) {
        this.setStatus({ ok: true, msg, channels: r.channels })
      } else {
        this.status.channels = r.channels
      }
      if (this.wasDown) {
        this.log.info('The Shelly EM is connected again.')
        this.wasDown = false
        this.errorLogged = 0
      }
    } catch (e) {
      const msg
        = e.name === 'TimeoutError'
          || /fetch failed|ECONN|EHOST|ENOTFOUND|ENETUNREACH/.test(e.message + (e.cause?.code || ''))
          ? `can't reach the Shelly EM at ${host}`
          : e.message
      this.setStatus({ ok: false, msg: msg.charAt(0).toUpperCase() + msg.slice(1) })
      this.wasDown = true
      this.downFails = (this.downFails || 0) + 1
      if (this.downFails >= 2) {
        this.downUntil = Date.now() + this.T.down[Math.min(this.downFails - 2, this.T.down.length - 1)]
      }
      if (Date.now() - this.errorLogged > 5 * 60e3) {
        this.log.warn(`Reading whole-house power failed: ${msg}. Trying again every few seconds.`)
        this.errorLogged = Date.now()
      }
    } finally {
      this.busy = false
    }
  }
}
