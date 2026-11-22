import { billPeriod } from './engine-shared.js'
// The engine's reports: the always-on load, the power graph, the week by hour, this month or bill, Ways to save and Where it went.
// Installed on Engine.prototype by lib/engine.js, so `this` is the engine.
import { dayKey, daysBack } from './engine-util.js'
import { insights } from './insights.js'
import { costOf, fixedPerDay, hasPlan, priceAt } from './tariff.js'

export const reportMethods = {
  /** Always-on load: the 5th percentile of the minute averages in a window (24 h by default), or null with under 30 minutes. */
  baseLoad(from = Date.now() - 86400e3, to = Date.now()) {
    const v = this.minutes
      .filter(m => m[0] > from && m[0] <= to)
      .map(m => m[1])
      .filter(x => x >= 0)
    if (v.length < 30) {
      return null
    }
    v.sort((a, b) => a - b)
    return v[Math.floor(v.length * 0.05)]
  },
  /**
   * Today's whole-house power for the graph on Today, in 5-minute steps from midnight (null where nothing was read), with
   * yesterday's for comparison, the always-on level and the peak. Includes the minute in progress, so it moves as you watch.
   * Worked out at most once every 15 s.
   */
  // the last 7 days hour by hour (kWh, the whole house), oldest first: hours still to come today are null. With a plan, `p` is
  // each hour's price per kWh that day (tax included), so the page can show which rate each hour was on, and what it cost
  weekHours(now = Date.now()) {
    const out = []
    const hourNow = new Date(now).getHours()
    const T = this.settings.tariff
    const plan = hasPlan(T)
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now)
      d.setHours(12, 0, 0, 0)
      d.setDate(d.getDate() - i)
      const k = dayKey(d.getTime())
      const h = this.energy[k]?.h
      out.push({
        day: k,
        h: h
          ? Array.from({ length: 24 }, (_, j) =>
              i === 0 && j > hourNow
                ? null
                : Math.round((h[j] || 0) * 1000) / 1000)
          : null,
        p: plan
          ? Array.from({ length: 24 }, (_, j) => {
              const t = new Date(d)
              t.setHours(j, 30, 0, 0)
              return Math.round(priceAt(T, t) * 1e5) / 1e5
            })
          : null,
      })
    }
    return out
  },
  curve(now = Date.now()) {
    const key = Math.floor(now / 15e3)
    if (this.curveCache?.key === key && this.curveCache.n === this.minutes.length) {
      return this.curveCache.v
    }
    const STEP = 300e3
    const d0 = new Date(now)
    d0.setHours(0, 0, 0, 0)
    const t0 = d0.getTime()
    const y = new Date(d0)
    y.setDate(y.getDate() - 1)
    const y0 = y.getTime() // a day can be 23 or 25 hours long: real midnights
    const slots = Math.ceil((t0 - y0) / STEP)
    const today = { s: [], n: [] }
    const yest = { s: [], n: [] }
    const add = (B, i, w) => {
      B.s[i] = (B.s[i] || 0) + w
      B.n[i] = (B.n[i] || 0) + 1
    }
    for (const [t, w] of this.minutes) {
      if (t >= t0 && t <= now) {
        add(today, Math.floor((t - t0) / STEP), w)
      } else if (t >= y0 && t < t0) {
        add(yest, Math.floor((t - y0) / STEP), w)
      }
    }
    const cur = this.samples.filter(x => x.t >= Math.floor(now / 60e3) * 60e3 && x.t >= t0) // the minute in progress
    if (cur.length) {
      add(today, Math.floor((now - t0) / STEP), cur.reduce((a, x) => a + x.p, 0) / cur.length)
    }
    const out = (B, n) => Array.from({ length: n }, (_, i) => (B.n[i]
      ? Math.round(B.s[i] / B.n[i])
      : null))
    const T = out(today, Math.floor((now - t0) / STEP) + 1)
    const Y = out(yest, slots)
    let peak = null
    T.forEach((w, i) => {
      if (w != null && (!peak || w > peak.w)) {
        peak = { w, t: t0 + i * STEP }
      }
    })
    const v = {
      start: t0,
      step: STEP,
      today: T,
      yesterday: Y.some(x => x != null)
        ? Y
        : null,
      base: this.energy[dayKey(now)]?.base ?? this.baseLoad(now - 86400e3, now),
      peak,
    }
    this.curveCache = { key, n: this.minutes.length, v }
    return v
  },
  /**
   * This month so far, and where it's heading: kWh and cost (with daily charges) so far, and a forecast from the average of the
   * last 14 days with readings. With a monthly budget: whether the forecast is over it. Worked out at most once a minute.
   */
  monthStatus(now = Date.now()) {
    const key = `${Math.floor(now / 60e3)}|${this.version}`
    if (this.monthCache?.key === key) {
      return this.monthCache.v
    }
    // the billing period (calendar months unless a bill day is set): so far, and where it's heading
    const T = this.settings.tariff
    const plan = hasPlan(T)
    const fixed = fixedPerDay(T)
    const B = billPeriod(now, this.settings.billDay)
    const dim = B.days
    const d0 = new Date(now)
    d0.setHours(0, 0, 0, 0)
    const dom = Math.round((d0 - B.start) / 86400e3) + 1 // today is day `dom` of the bill
    let kwh = 0
    let cost = 0
    let days = 0
    for (let i = 0; i < dom; i++) {
      const t = new Date(B.start)
      t.setDate(t.getDate() + i)
      const k = dayKey(t.getTime())
      const e = this.energy[k]
      if (!e) {
        continue
      }
      days++
      kwh += e.total || 0
      cost += costOf(T, k, e.total, e.h) + fixed
    }
    let n = 0
    let aK = 0
    let aC = 0
    for (let i = 1; i <= 14; i++) {
      const k = daysBack(now, i)
      const e = this.energy[k]
      if (!e) {
        continue
      }
      n++
      aK += e.total || 0
      aC += costOf(T, k, e.total, e.h)
    }
    const leftToday = 1 - (now - d0.getTime()) / 86400e3
    const rest = dim - dom
    const last = new Date(B.end)
    last.setDate(last.getDate() - 1)
    const v = {
      kwh,
      cost: plan ? cost : null,
      days,
      dim,
      dom,
      basis: n,
      plan,
      budget: this.settings.budget || null,
      billDay: this.settings.billDay || 1,
      from: dayKey(B.start.getTime()),
      to: dayKey(last.getTime()),
      forecastKwh: n
        ? kwh + (aK / n) * (rest + leftToday)
        : null,
      forecastCost: n && plan
        ? cost + (aC / n) * (rest + leftToday) + fixed * rest
        : null,
    }
    v.over = !!(v.budget && v.forecastCost != null && v.forecastCost > v.budget)
    this.monthCache = { key, v }
    return v
  },
  budget(now) {
    return this.monthStatus(now)
  },
  // The plugin's own sums against the meter's count, over the last 7 full days that have the count: how far apart they are.
  // ours: what the readings added up to, plus gaps filled from the count; meter: how far the count went.
  meterCheck(now = Date.now()) {
    let ours = 0
    let meter = 0
    let days = 0
    for (let i = 1; i <= 7; i++) {
      const e = this.energy[daysBack(now, i)]
      if (!e || e.wh0 == null || e.wh1 == null || e.whReset || e.wh1 < e.wh0) {
        continue
      }
      ours += (e.seen || 0) + (e.fill || 0)
      meter += (e.wh1 - e.wh0) / 1000
      days++
    }
    if (days < 2 || meter < 1) {
      return null
    }
    return {
      days,
      ours,
      meter,
      pct: (ours / meter - 1) * 100,
    }
  },
  // Settings → Data: when it last saved, how big the saved files are, and today's missing readings
  health(now = Date.now()) {
    const t = this.energy[dayKey(now)] || {}
    return {
      savedAt: this.savedAt || null,
      bytes: this.savedBytes || 0,
      histBytes: this.histBytes || 0,
      recovered: this.recovered || null,
      missMin: Math.round((t.miss || 0) / 60),
      fillKwh: t.fill || 0,
      counter: this.lastWh != null,
      check: this.meterCheck(now),
    }
  },
  // Ways to save (lib/insights.js): worked out at most once a minute, or when something changed
  insights(now = Date.now()) {
    const key = `${this.version}:${Math.floor(now / 60e3)}`
    if (this.insightCache?.key !== key) {
      this.insightCache = {
        key,
        v: insights(this, now),
      }
    }
    return this.insightCache.v
  },
  dismissTip(key) {
    if (!key) {
      this.settings.tipsDismissed = {}
      this.changed()
      return
    } // show all again
    const t = this.insights().tips.find(x => x.key === key)
    this.settings.tipsDismissed[String(key).slice(0, 80)] = t
      ? (t.costYear ?? t.kwhYear ?? 0)
      : 0
    const k = Object.keys(this.settings.tipsDismissed)
    if (k.length > 300) {
      delete this.settings.tipsDismissed[k[0]]
    }
    this.changed()
  },
  // ---------- summaries for the settings page ----------
  /** Energy and cost per appliance over the last `days` days (1 = today), plus Other, the total and the always-on load. */
  summary(days = 1, now = Date.now()) {
    days = Math.min(366, Math.max(1, Math.round(+days) || 1))
    const T = this.settings.tariff
    const plan = hasPlan(T)
    const keys = []
    for (let i = 0; i < days; i++) keys.push(daysBack(now, i))
    const per = {}
    let total = 0
    let totalCost = 0
    let other = 0
    let otherCost = 0
    let daysWithData = 0
    for (const k of keys) {
      const d = this.energy[k]
      if (!d) {
        continue
      }
      daysWithData++
      total += d.total || 0
      totalCost += costOf(T, k, d.total, d.h)
      other += d.other || 0
      otherCost += costOf(T, k, d.other, d.oh)
      for (const [id, kwh] of Object.entries(d.apps || {})) {
        const x = (per[id] ??= { kwh: 0, cost: 0 })
        x.kwh += kwh
        x.cost += costOf(T, k, kwh, d.ah?.[id])
      }
    }
    const rows = Object.entries(per)
      .map(([id, x]) => {
        const s = this.sigById(id)
        return s
          ? {
              id,
              name: s.name,
              icon: s.icon,
              room: s.room || '',
              kwh: x.kwh,
              cost: x.cost,
            }
          : null
      })
      .filter(r => r && r.kwh > 0.0005)
      .sort((a, b) => b.kwh - a.kwh)
    const base = this.baseLoad(now - 86400e3, now)
    const fixed = fixedPerDay(T) * daysWithData
    const standby = this.sigs
      .filter(s => s.metered && !s.estimated && (s.standbyW || 0) >= (this.settings.standbyThreshold || 1))
      .map(s => ({ id: s.id, name: s.name, w: Math.round(s.standbyW * 10) / 10 }))
      .sort((a, b) => b.w - a.w)
    return {
      days,
      daysWithData,
      plan,
      currency: this.settings.currency,
      rows,
      other: { kwh: other, cost: otherCost },
      total: { kwh: total, cost: totalCost },
      fixed,
      base: base == null
        ? null
        : Math.round(base),
      baseYearKwh: base == null
        ? null
        : Math.round(base * 8.76),
      standby,
    }
  },
}
