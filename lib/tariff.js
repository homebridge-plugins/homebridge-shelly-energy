// Electricity plan: a flat rate or time-of-use periods, a daily charge, and tax (GST/VAT) if the prices exclude it.

const num = (v, max = 1000) => Math.min(max, Math.max(0, +v || 0));
const hour = v => Math.min(24, Math.max(0, Math.round(+v || 0)));
const DAYS = ['all', 'weekdays', 'weekends'];

export function cleanTariff(t = {}) {
  t = t && typeof t === 'object' ? t : {};
  const periods = (Array.isArray(t.periods) ? t.periods : []).slice(0, 8).map(p => ({
    name: String(p?.name || 'Rate').trim().slice(0, 30) || 'Rate', from: hour(p?.from), to: hour(p?.to), rate: num(p?.rate),
    days: DAYS.includes(p?.days) ? p.days : 'all' }));
  return { mode: t.mode === 'tou' ? 'tou' : 'single', rate: num(t.rate), fixed: num(t.fixed), tax: Math.min(50, num(t.tax)),
    taxIncl: t.taxIncl !== false, periods, plan: String(t.plan || '').slice(0, 60) };
}

// the plan's own price per kWh in the hour that `date` falls in (before tax is added)
export function rateAt(t, date = new Date()) {
  if (!t || t.mode !== 'tou') return t?.rate ?? 0;
  const h = date.getHours(), wk = [0, 6].includes(date.getDay());
  for (const p of t.periods || []) {
    if (p.days === 'weekdays' && wk) continue;
    if (p.days === 'weekends' && !wk) continue;
    const inP = p.from <= p.to ? h >= p.from && h < p.to : h >= p.from || h < p.to; // a period can wrap past midnight (21 to 7)
    if (inP) return p.rate;
  }
  return t.rate;
}
const taxF = t => (t && !t.taxIncl ? 1 + (t.tax || 0) / 100 : 1);
/** What a kWh costs in that hour, tax included. */
export const priceAt = (t, date = new Date()) => rateAt(t, date) * taxF(t);
export const fixedPerDay = t => (t?.fixed || 0) * taxF(t);
export const hasPlan = t => !!t && (t.rate > 0 || (t.mode === 'tou' && (t.periods || []).some(p => p.rate > 0)));

// "cheap power now": a time-of-use plan, and this hour is at the plan's lowest price
export function cheapNow(t, date = new Date()) {
  if (!t || t.mode !== 'tou' || !(t.periods || []).length) return false;
  const all = [t.rate, ...t.periods.map(p => p.rate)].filter(v => v > 0);
  if (!all.length) return false;
  const low = Math.min(...all);
  return Math.max(...all) > low && rateAt(t, date) <= low + 1e-9;
}

// cost of a day's kWh: `hours` is 24 kWh figures (or missing: priced at the day's middle hour), `key` 'YYYY-MM-DD'
export function costOf(t, key, kwh, hours) {
  if (!hasPlan(t)) return 0;
  const [y, m, d] = key.split('-').map(Number);
  if (Array.isArray(hours) && hours.length === 24) {
    let c = 0; for (let h = 0; h < 24; h++) if (hours[h]) c += hours[h] * priceAt(t, new Date(y, m - 1, d, h, 30));
    return c;
  }
  return (kwh || 0) * priceAt(t, new Date(y, m - 1, d, 12, 30));
}
