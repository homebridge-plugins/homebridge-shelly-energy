// Matter hubs (1.76.0): turning a hub's endpoint tree into sensor devices. Pure functions, used by
// lib/matter-controller.js and unit-tested in test/hub-unit.mjs (no Matter hardware needed).
// A tree node: { number, clusters: [ids], types: [device type ids], label, children: [nodes] }.
// Any Matter device (1.77.0): hubs and single devices alike - sensors, lights, switches, outlets, blinds, thermostats, locks, power meters.
const BOOLEAN_STATE = 0x0045
const OCCUPANCY = 0x0406
const TEMPERATURE = 0x0402
const HUMIDITY = 0x0405
const POWER_SOURCE = 0x002F
const BRIDGED_INFO = 0x0039
const ON_OFF = 0x0006
const LEVEL = 0x0008
const COVERING = 0x0102
const THERMOSTAT = 0x0201
const LOCK = 0x0101
const ILLUMINANCE = 0x0400
const POWER = 0x0090
export const HUB_ATTRS = {
  [`${BOOLEAN_STATE}:0`]: 'state',
  [`${OCCUPANCY}:0`]: 'occupied',
  [`${TEMPERATURE}:0`]: 'temp',
  [`${HUMIDITY}:0`]: 'hum',
  [`${POWER_SOURCE}:12`]: 'battery',
  [`${ON_OFF}:0`]: 'on',
  [`${LEVEL}:0`]: 'level',
  [`${COVERING}:14`]: 'position',
  [`${THERMOSTAT}:0`]: 'temp',
  [`${LOCK}:0`]: 'lock',
  [`${ILLUMINANCE}:0`]: 'lux',
  [`${POWER}:8`]: 'watts',
  [`${BRIDGED_INFO}:17`]: 'reachable',
  [`${POWER_SOURCE}:14`]: 'batteryLow',
} // 1.81.0: reachable (bridged devices), battery charge level (0 ok, 1 warning, 2 critical)
const SENSOR = [
  BOOLEAN_STATE,
  OCCUPANCY,
  TEMPERATURE,
  HUMIDITY,
  ON_OFF,
  LEVEL,
  COVERING,
  THERMOSTAT,
  LOCK,
  ILLUMINANCE,
  POWER,
]

/** One device per bridged endpoint (has Bridged Device Basic Information); child endpoints' readings belong to it. */
export function hubDevices(roots) {
  const groups = new Map()
  const devices = new Map()
  const walk = (ep, group) => {
    if (!ep || groups.has(ep.number)) {
      return
    }
    const own = ep.number !== 0 && ep.clusters.includes(BRIDGED_INFO)
      ? ep.number
      : group
    const sensors = ep.clusters.filter(id => SENSOR.includes(id))
    const g = own ?? (sensors.length ? ep.number : null)
    if (ep.number !== 0 && g != null) {
      groups.set(ep.number, g)
      const d = devices.get(g) || {
        endpoint: g,
        name: '',
        types: [],
        clusters: [],
      }
      d.types.push(...(ep.types || []))
      d.clusters.push(...sensors)
      if (ep.label && (!d.name || ep.number === g)) {
        d.name = String(ep.label).slice(0, 80)
      }
      devices.set(g, d)
    }
    for (const c of ep.children || []) walk(c, own)
  }
  for (const r of roots) walk(r, null)
  let list = [
    ...devices.values(),
  ]
    .filter(d => d.clusters.length)
    .map(d => ({
      ...d,
      types: [
        ...new Set(d.types),
      ],
      clusters: [
        ...new Set(d.clusters),
      ],
    }))
  // A plug that mirrors its watts on a second, relay-less endpoint (IKEA GRILLPLATS) would show twice: when several endpoints
  // report power, keep the ones that also switch (the same rule the smart-plug path uses).
  const metered = list.filter(d => d.clusters.includes(POWER))
  if (metered.length > 1 && metered.some(d => d.clusters.includes(ON_OFF))) {
    list = list.filter(
      d =>
        !d.clusters.includes(POWER)
        || d.clusters.includes(ON_OFF)
        || d.clusters.some(c => [
          BOOLEAN_STATE,
          OCCUPANCY,
          TEMPERATURE,
          HUMIDITY,
        ].includes(c)),
    )
  }
  return { groups, devices: list }
}

export function hubValue(key, v) {
  if (v === null || v === undefined) {
    return null
  }
  if (key === 'state') {
    return !!v
  }
  if (key === 'occupied') {
    return typeof v === 'object'
      ? !!v.occupied
      : !!(Number(v) & 1)
  }
  if (key === 'temp' || key === 'hum') {
    return Number.isFinite(Number(v))
      ? Math.round(Number(v)) / 100
      : null
  }
  if (key === 'battery') {
    return Number.isFinite(Number(v))
      ? Math.round(Number(v) / 2)
      : null
  }
  const n = Number(v)
  if (key !== 'on' && !Number.isFinite(n)) {
    return null
  }
  if (key === 'on' || key === 'reachable') {
    return !!v
  }
  if (key === 'batteryLow') {
    return n
  }
  if (key === 'level') {
    return Math.round((n / 254) * 100)
  }
  if (key === 'position') {
    return Math.round(100 - n / 100)
  } // Matter: 0 % = fully open; Apple Home: 100 % = open
  if (key === 'lock') {
    return n === 1
      ? 1
      : n === 2
        ? 0
        : 3
  }
  if (key === 'lux') {
    return n > 0
      ? Math.round(10 ** ((n - 1) / 10000))
      : 0
  }
  if (key === 'watts') {
    return Math.round(n) / 1000
  } // mW
  return null
}
