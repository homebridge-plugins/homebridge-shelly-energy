// Small helpers shared by the engine and the pure modules.
import crypto from 'node:crypto'

export const tolFor = w => Math.max(30, w * 0.15) // how close two power steps must be to count as the same appliance
export function median(a) {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2
    ? s[m]
    : (s[m - 1] + s[m]) / 2
}
export function mad(a) {
  const m = median(a)
  return median(a.map(x => Math.abs(x - m)))
}
export const uid = () => crypto.randomBytes(5).toString('hex')
export function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/**
 * The day key of the calendar day `n` days before the day of `t` (not `t` minus n × 24 hours, which skips a day when a
 * clock change makes a day 23 hours long).
 */
export function daysBack(t, n) {
  const d = new Date(t)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime())
}

// the "running" indicator tile an appliance can show in Apple Home over HAP (lib/hap-tiles.js)
const STATUS_TYPES = [
  'none',
  'faucet',
  'switch',
  'outlet',
  'light',
  'fan',
  'purifier',
  'humidifier',
  'dehumidifier',
  'heater',
  'cooler',
  'occupancy',
  'contact',
  'motion',
]
export function normStatusType(t, dflt) {
  return STATUS_TYPES.includes(t)
    ? t
    : dflt
}
// steady outlet: false (flickers with each cycle), true (always on: fridges), 'idle' (on through gaps shorter than steadyIdleMin)
export function normSteady(v) {
  return v === 'idle'
    ? 'idle'
    : !!v
}
export function normIdleMin(v) {
  const n = Math.round(+v)
  return Number.isFinite(n) && n > 0
    ? Math.min(180, n)
    : 10
}
export function normStatusCount(v) {
  const n = Math.round(+v)
  return Number.isFinite(n) && n > 0
    ? Math.min(10, n)
    : 1
}

// door, window, motion, leak, smoke… sensors and locks report open/detected, not a load switching
export const isSensor = a => /Sensor|Detector|Lock|Security|^Door$|^Window$|GarageDoor|Doorbell/i.test(a?.type || '')

// appliance icons: Material Symbols names (kept in saved data), each shown as an emoji
export const ICONS = {
  bolt: '⚡',
  power: '🔌',
  kitchen: '🧊',
  kettle: '🫖',
  coffee_maker: '☕',
  microwave: '📟',
  oven_gen: '🍳',
  cooking: '🍳',
  countertops: '🍞',
  dishwasher_gen: '🍽️',
  local_laundry_service: '🧺',
  dry_cleaning: '👕',
  iron: '👔',
  shower: '🚿',
  heat: '🔥',
  heat_pump: '♨️',
  mode_fan: '🌀',
  ac_unit: '❄️',
  light: '💡',
  lightbulb: '💡',
  tv: '📺',
  computer: '💻',
  router: '📶',
  speaker: '🔊',
  videogame_asset: '🎮',
  pool: '🏊',
  hot_tub: '🛁',
  electric_car: '🚗',
  ev_station: '🔋',
  water_pump: '💧',
  garage: '🚪',
  yard: '🌿',
  bed: '🛏️',
  fitness_center: '🏋️',
  devices: '🔌',
  print: '🖨️',
  vacuum: '🧹',
}
export function cleanIcon(v) {
  return typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v)
    ? v
    : null
}

// the whole-house meter readings that can be chosen: Gen2+ (em1:N, em:N, pm1:N, switch:N) and Gen1 (emeter:N, meter:N)
export const EM_CHANNEL = /^(?:auto|sum|em1?:\d|pm1:\d|switch:\d|emeter:\d|meter:\d)$/
