// The whole-house meter: a Shelly EM (Gen3/Gen4, EM Mini Gen4: em1:N), Pro EM, Pro 3EM / 3EM-63 (em:N) or any metered Shelly,
// read over its local RPC API; or a Gen1 Shelly EM / 3EM (emeters[] in /status).
import { getDevice } from './net.js'

export function parseChannels(st) {
  const out = []
  for (const [k, v] of Object.entries(st || {})) {
    if (!v || typeof v !== 'object') {
      continue
    }
    if (k.startsWith('em1:') && typeof v.act_power === 'number') {
      out.push({ key: k, label: `CT clamp ${+k.split(':')[1] + 1}`, p: v.act_power })
    } else if (k.startsWith('em:') && typeof v.total_act_power === 'number') {
      out.push({ key: k, label: '3-phase total', p: v.total_act_power })
    } else if ((k.startsWith('pm1:') || k.startsWith('switch:')) && typeof v.apower === 'number') {
      out.push({ key: k, label: k, p: v.apower })
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
      })
    }
  })
  ;(Array.isArray(st?.meters)
    ? st.meters
    : []).forEach((v, i) => {
    if (v && v.is_valid !== false && typeof v.power === 'number') {
      out.push({ key: `meter:${i}`, label: `Meter ${i + 1}`, p: v.power })
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
  return {
    p,
    key: sel.length === 1
      ? sel[0].key
      : 'sum',
    channels: chs.map(c => ({ key: c.key, label: c.label, p: c.p })),
  }
}

// Polls the meter once a second, never two requests at once; reports a clear status and logs at most every 5 minutes while down.
export class EmPoller {
  constructor({ log, onSample, onStatus = () => {}, fetchImpl = fetch, interval = 1000 }) {
    this.log = log
    this.onSample = onSample
    this.onStatus = onStatus
    this.fetch = fetchImpl
    this.interval = interval
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
  }

  async poll() {
    if (this.busy || !this.host) {
      return
    }
    this.busy = true
    const host = this.host
    try {
      const r = await readShelly(host, this.channel, this.fetch)
      if (host !== this.host) {
        return
      }
      this.onSample(Date.now(), r.p)
      this.keys = r.key === 'sum'
        ? r.channels.map(c => c.key)
        : [r.key]
      const label = r.channels.find(c => c.key === r.key)?.label || (r.key === 'sum'
        ? 'all clamps'
        : r.key)
      if (!this.status.ok || this.status.channels?.length !== r.channels.length) {
        this.setStatus({ ok: true, msg: `Live (${label})`, channels: r.channels })
      } else {
        this.status.channels = r.channels
      }
      if (this.wasDown) {
        this.log.info('The Shelly EM is answering again.')
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
      if (Date.now() - this.errorLogged > 5 * 60e3) {
        this.log.warn(`Reading whole-house power failed: ${msg}. Still trying every second.`)
        this.errorLogged = Date.now()
      }
    } finally {
      this.busy = false
    }
  }
}
