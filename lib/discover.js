// Find Shellys: asks every address on the Homebridge computer's own home network for /shelly (every stock Shelly answers it,
// Gen1 without a "gen" number) or, failing that, Shelly.GetInfoExt (the open HomeKit firmware). Only run when asked, from the
// settings page; never in the background. Home-network addresses only; read-only, like the rest of the plugin.
// Where a Shelly's .local name resolves to the address it answered on, that name is offered instead of the address, so it keeps
// working when the router hands out a new address.

import dns from 'node:dns'
import os from 'node:os'

import { isLanHost, lanHost } from './hosts.js'
import { getDevice } from './net.js'
import { gen1Devices, hkDevices, rpcDevices } from './shelly-devices.js'

const MAX_ADDRESSES = 1024
const SMALLEST_PREFIX = 22 // a bigger network is scanned as the /24 around this computer
const ipNum = ip => ip.split('.').reduce((n, x) => n * 256 + +x, 0)
const numIp = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.')
function prefixOf(mask) {
  return mask.split('.').reduce(
    (n, x) =>
      n
      + (+x)
        .toString(2)
        .split('')
        .filter(b => b === '1')
        .length,
    0,
  )
}

/** The addresses to ask: each home-network IPv4 network this computer is on (not itself). */
export function scanTargets(ifaces = os.networkInterfaces()) {
  const nets = new Map()
  const self = new Set()
  for (const a of Object.values(ifaces).flat()) {
    if (
      !a
      || (a.family !== 'IPv4' && a.family !== 4)
      || a.internal
      || !isLanHost(a.address)
      || /^(?:127|169\.254)\./.test(a.address)
    ) {
      continue
    }
    self.add(a.address)
    let prefix = a.cidr
      ? +a.cidr.split('/')[1]
      : prefixOf(a.netmask || '255.255.255.0')
    if (!(prefix >= 1 && prefix <= 30)) {
      continue
    }
    if (prefix < SMALLEST_PREFIX) {
      prefix = 24
    }
    const size = 2 ** (32 - prefix)
    const base = Math.floor(ipNum(a.address) / size) * size
    nets.set(`${numIp(base)}/${prefix}`, { base, size })
  }
  const hosts = []
  for (const { base, size } of nets.values()) {
    for (let n = base + 1; n < base + size - 1 && hosts.length < MAX_ADDRESSES; n++) {
      const ip = numIp(n)
      if (!self.has(ip)) {
        hosts.push(ip)
      }
    }
  }
  return {
    networks: [
      ...nets.keys(),
    ],
    hosts: [
      ...new Set(hosts),
    ],
  }
}

async function getJson(fetchImpl, host, path, timeout) {
  const r = await getDevice(fetchImpl, host, path, { timeout, max: 256 * 1024 })
  return {
    status: r.status,
    j: r.json && typeof r.json === 'object'
      ? r.json
      : null,
  }
}

// one address: a Shelly description, or null
async function probe(host, { fetchImpl, timeout }) {
  const get = path => getJson(fetchImpl, host, path, timeout).catch(() => ({ status: 0, j: null }))
  const r = await getJson(fetchImpl, host, 'shelly', timeout).catch(() => null)
  if (!r) {
    return null
  } // nothing listening there
  const id = r.status === 200
    ? r.j
    : null
  let out = null
  if (id && id.gen >= 2) {
    out = {
      kind: 'rpc',
      gen: +id.gen,
      id: String(id.id || '').slice(0, 60),
      name: String(id.name || '').trim(),
      model: String(id.model || '').slice(0, 40),
      app: String(id.app || '').slice(0, 40),
      password: id.auth_en === true,
      hostname: id.id,
    }
    if (!out.password) {
      const st = await get('rpc/Shelly.GetStatus')
      const cfg = await get('rpc/Shelly.GetConfig')
      out.list = rpcDevices(id, cfg.j, st.j, host)
      out.name ||= String(cfg.j?.sys?.device?.name || '').trim()
    }
  } else if (id && typeof id.type === 'string' && id.mac) {
    out = {
      kind: 'gen1',
      gen: 1,
      id: String(id.mac).toLowerCase().slice(0, 60),
      name: '',
      model: id.type.slice(0, 40),
      app: '',
      password: id.auth === true,
      hostname: null,
    }
    if (!out.password) {
      const s = await get('settings')
      const st = await get('status')
      out.name = String(s.j?.name || '').trim()
      out.hostname = s.j?.device?.hostname || null
      out.list = gen1Devices(id, s.j, st.j, host)
    }
  } else {
    const hk = await get('rpc/Shelly.GetInfoExt')
    if (!hk.j || !Array.isArray(hk.j.components)) {
      return null
    } // a web server, but not a Shelly
    out = {
      kind: 'homekit',
      gen: null,
      id: String(hk.j.device_id || '').slice(0, 60),
      name: String(hk.j.name || '').trim(),
      model: String(hk.j.model || '').slice(0, 40),
      app: '',
      password: false,
      hostname: hk.j.hostname || hk.j.device_id || null,
      list: hkDevices(hk.j, host),
    }
  }
  const list = out.list || []
  delete out.list
  return {
    ...out,
    name: out.name.slice(0, 80),
    ip: host,
    channels: list.length,
    measures: list.some(d => typeof d.values?.Watts === 'number'),
    parts: list.map(d => d.name).slice(0, 8),
  }
}

// the Shelly's .local name, when it resolves (on this computer) to the address it answered on
async function localName(s, lookup, timeout) {
  const raw = String(s.hostname || '')
    .toLowerCase()
    .replace(/\.local$/, '')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)) {
    return null
  }
  const name = `${raw}.local`
  const ip = s.ip.replace(/:\d+$/, '')
  const port = /:\d+$/.exec(s.ip)?.[0] || ''
  if (!lanHost(name)) {
    return null
  }
  try {
    const r = await Promise.race([
      lookup(name, { family: 4 }),
      new Promise((_, no) => setTimeout(() => no(new Error('slow')), timeout).unref?.()),
    ])
    return r?.address === ip
      ? name + port
      : null
  } catch {
    return null
  }
}

/**
 * Ask each address for a Shelly. Returns { networks, scanned, found: [{ ip, host, name, model, kind, gen, id, password,
 * channels, measures, parts }], ms }. host = the .local name when it checks out, otherwise the IP address.
 */
export async function findShellys({
  targets = scanTargets(),
  fetchImpl = fetch,
  lookup = dns.promises.lookup,
  concurrency = 48,
  timeout = 1500,
  nameTimeout = 2000,
} = {}) {
  const t0 = Date.now()
  const hosts = targets.hosts.filter(h => isLanHost(h))
  const found = []
  let next = 0
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++]
      try {
        const s = await probe(h, { fetchImpl, timeout })
        if (s) {
          found.push(s)
        }
      } catch {}
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(concurrency, hosts.length),
      },
      worker,
    ),
  )
  await Promise.all(
    found.map(async (s) => {
      s.host = (await localName(s, lookup, nameTimeout)) || s.ip
      delete s.hostname
    }),
  )
  found.sort((a, b) => ipNum(a.ip.replace(/:\d+$/, '')) - ipNum(b.ip.replace(/:\d+$/, '')) || a.ip.localeCompare(b.ip))
  return {
    networks: targets.networks,
    scanned: hosts.length,
    found,
    ms: Date.now() - t0,
  }
}
