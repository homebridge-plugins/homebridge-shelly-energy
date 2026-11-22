// Constants and small helpers shared by the engine and its parts (lib/engine*.js).
export const W = 3 // samples per detection window
export const SAMPLE_HISTORY = 3600e3 // 1 h of 1-second readings in memory (not saved)
export const MINUTE_HISTORY = 7 * 86400e3 // per-minute averages: 7 days
export const MAX_EVENTS = 2000
export const MAX_DEV_EVENTS = 2000
export const MAX_DAYS = 800
export const HOURLY_DAYS = 400
export const RECENT_RUNS = 20
export const MAX_SIGS = 300
export const MAX_MATTER = 100
export const normBillDay = v => Math.min(28, Math.max(1, Math.round(+v) || 1))
// the billing period that `now` falls in: from the bill day of this month (or last month, before it) up to the day before the next
export function billPeriod(now, billDay = 1) {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = d.getMonth()
  const b = normBillDay(billDay)
  const start = d.getDate() >= b
    ? new Date(y, m, b)
    : new Date(y, m - 1, b)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, b) // end: the next bill's first day
  return {
    start,
    end,
    days: Math.round((end - start) / 86400e3),
  }
}
export function sameName(a, b) {
  return String(a || '')
    .trim()
    .toLowerCase()
    === String(b || '')
      .trim()
      .toLowerCase()
}
// appliances that turn their own power up and down: a new one with one of these names starts as a variable load
export const VARIABLE_NAMES = /heat ?pump|air ?con|\bac\b|ev charg|car charg|inverter|wall ?box/i
export const STALE_READING = 10 * 60e3 // a measured reading older than this counts as nothing
export const SWITCH_WINDOW = { shelly: 4e3, matter: 3e3 } // how long before a change was seen it can have happened (poll gaps)

export function clean(v, n) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}
export const SKIP_WHY = [
  'busy',
  'noisy',
  'readings',
  'late',
  'wrongway',
] // why a switch couldn't be measured from the whole-house meter
export function cleanDevEst(v) {
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
          ...(x.why && typeof x.why === 'object'
            ? {
                why: Object.fromEntries(
                  Object.entries(x.why)
                    .filter(([k, n]) => SKIP_WHY.includes(k) && Number.isFinite(+n))
                    .map(([k, n]) => [k, +n]),
                ),
              }
            : {}),
        }
      }
    }
  }
  return out
}
// numbers rounded when saved: 6 decimals keeps kWh to a milliwatt-hour and roughly halves the file
export function roundJson(k, v) {
  return typeof v === 'number' && !Number.isInteger(v)
    ? Math.round(v * 1e6) / 1e6
    : v
}
// readings further apart than this are a gap: filled from the meter's own count. A count rising faster than MAX_GAP_KW
// over a gap isn't believed (a different meter, a reset).
export const GAP = 10e3
export const MAX_GAP_KW = 100
