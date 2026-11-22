// Record readings for tuning: the whole-house meter's every reading (watts, and reactive power where the meter gives it) and
// every change of the devices this plugin reads, for up to 48 hours, to a compressed file in <data>/recordings. Replayed through
// the engine (test/replay.mjs), it shows how well appliances are found and named in a real home, so changes can be tuned on
// real readings. Only when asked; the newest 5 are kept. The file kept on the Homebridge computer has the devices' own ids and
// names; a download never does: anonymize() gives each device a number ("device 1") and, where an appliance tracks it, the
// kind of appliance from its icon ("kettle"), and drops everything else that could say whose home it is.
//
// The file: gzip of JSON lines. First { v: 1, start, plugin, threshold }, then
//   ["m", t, watts, reactive|null]                        a meter reading
//   ["d", t, id, name|null, on|null, watts|null, type|null] a device that changed (name and type the first time it's seen)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { privateDir } from './private-dir.js'

const KEEP = 5
const MAX_HOURS = 48
const NAME_RE = /^rec-\d{4}-\d\d-\d\d-\d{4}\.jsonl\.gz$/
function r1(v) {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(v * 10) / 10
    : null
}

export class Recorder {
  constructor({ dir, log, plugin = '' }) {
    this.dir = path.join(dir, 'recordings')
    this.log = log
    this.plugin = plugin
    this.cur = null
  }

  /** Start recording for `hours` (1-48). */
  start(hours = 24, settings = {}) {
    if (this.cur) {
      throw Object.assign(new Error('Already recording.'), { user: true })
    }
    hours = Math.min(MAX_HOURS, Math.max(1, Math.round(+hours) || 24))
    privateDir(this.dir)
    const d = new Date()
    const p2 = n => String(n).padStart(2, '0')
    const name = `rec-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.jsonl.gz`
    const file = path.join(this.dir, name)
    const gz = zlib.createGzip()
    const out = fs.createWriteStream(file, { mode: 0o600 })
    gz.pipe(out)
    const c = {
      name,
      file,
      gz,
      out,
      start: Date.now(),
      until: Date.now() + hours * 3600e3,
      lines: 0,
      seen: new Map(),
    }
    // a write that fails ends this recording only: its timer too, so it can't stop a later one
    out.on('error', (e) => {
      this.log.warn(`Recording stopped: ${e.message}`)
      clearTimeout(c.timer)
      gz.destroy()
      if (this.cur === c) {
        this.cur = null
      }
    })
    this.cur = c
    this.write({
      v: 1,
      start: this.cur.start,
      plugin: this.plugin,
      threshold: settings.threshold ?? null,
    })
    c.timer = setTimeout(() => {
      if (this.cur === c) {
        this.stop()
      }
    }, hours * 3600e3)
    c.timer.unref?.()
    this.log.info(`Recording readings for ${hours} h to ${file}`)
    this.prune()
    return this.status()
  }

  write(x) {
    const c = this.cur
    if (!c) {
      return
    }
    c.gz.write(`${JSON.stringify(x)}\n`)
    c.lines++
  }

  sample(t, p, q = null) {
    if (this.cur) {
      if (t >= this.cur.until) {
        return this.stop()
      }
      this.write([
        'm',
        t,
        r1(p),
        r1(q),
      ])
    }
  }

  // a source's whole list: only the devices that changed since the last one are written
  devices(list, t = Date.now()) {
    const c = this.cur
    if (!c) {
      return
    }
    for (const a of list || []) {
      const w = r1(a.values?.Watts)
      const on = typeof a.on === 'boolean'
        ? a.on
        : null
      const prev = c.seen.get(a.id)
      if (prev && prev.on === on && prev.w === w) {
        continue
      }
      this.write([
        'd',
        t,
        String(a.id).slice(0, 200),
        prev
          ? null
          : String(a.name || '').slice(0, 80),
        on,
        w,
        prev
          ? null
          : String(a.type || '').slice(0, 30),
      ])
      c.seen.set(a.id, { on, w })
    }
  }

  stop() {
    const c = this.cur
    if (!c) {
      return this.status()
    }
    this.cur = null
    clearTimeout(c.timer)
    c.gz.end()
    this.log.info(`Recording finished: ${Math.round((Date.now() - c.start) / 360e3) / 10} h, ${c.name}`)
    return this.status()
  }

  status() {
    const c = this.cur
    return {
      on: !!c,
      name: c?.name || null,
      start: c?.start || null,
      until: c?.until || null,
      folder: this.dir,
      list: this.list(),
    }
  }

  list() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter(f => NAME_RE.test(f))
        .map(f => ({ name: f, size: fs.statSync(path.join(this.dir, f)).size, recording: f === this.cur?.name }))
        .sort((a, b) => b.name.localeCompare(a.name))
    } catch {
      return []
    }
  }

  prune() {
    for (const f of this.list()
      .filter(x => !x.recording)
      .slice(KEEP - 1)) {
      try {
        fs.unlinkSync(path.join(this.dir, f.name))
      } catch {}
    }
  }

  /** A finished recording's bytes (by listed name only), anonymized for download (see anonymize()). */
  read(name, opts = {}) {
    const f = this.list().find(x => x.name === name && !x.recording)
    if (!f) {
      throw new Error('That isn\'t one of the finished recordings.')
    }
    return anonymize(fs.readFileSync(path.join(this.dir, name)), opts)
  }

  remove(name) {
    const f = this.list().find(x => x.name === name && !x.recording)
    if (!f) {
      throw new Error('That isn\'t one of the finished recordings.')
    }
    fs.unlinkSync(path.join(this.dir, name))
    return true
  }
}

// A recording made safe to share: devices become "device 1", "device 2"… (in the order they first appear), each with only
// the kind of appliance it powers where one tracks it (kindOf(id), e.g. "kettle") and its generic type (Switch, Outlet…);
// no ids, names, addresses or rooms. Times are kept (what an appliance does depends on the time of day), with the time
// zone's offset so they can be read as local times. Older recordings are made safe the same way.
export function anonymize(buf, { kindOf = () => null, tzOffsetMin = -new Date().getTimezoneOffset() } = {}) {
  const rows = zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean)
  const ids = new Map()
  const out = []
  const head = (() => {
    try {
      return JSON.parse(rows[0])
    } catch {
      return {}
    }
  })()
  out.push(
    JSON.stringify({
      v: 2,
      anonymized: true,
      start: head.start ?? null,
      tzOffsetMin,
      threshold: head.threshold ?? null,
      format: {
        m: '["m", time ms UTC, whole-house watts, reactive VAR or null]',
        d: '["d", time ms UTC, device, kind of appliance or null, on/off or null, watts or null, device type or null]',
      },
    }),
  )
  for (const line of rows.slice(1)) {
    let x
    try {
      x = JSON.parse(line)
    } catch {
      continue
    }
    if (x[0] === 'm') {
      out.push(JSON.stringify(['m', x[1], x[2], x[3] ?? null]))
    } else if (x[0] === 'd') {
      const first = !ids.has(x[2])
      if (first) {
        ids.set(x[2], `device ${ids.size + 1}`)
      }
      let kind = null
      if (first) {
        try {
          kind = kindOf(x[2]) || null
        } catch {}
      }
      const type = first && /^[A-Z ]{1,30}$/i.test(x[6] || '')
        ? x[6]
        : null
      out.push(
        JSON.stringify([
          'd',
          x[1],
          ids.get(x[2]),
          first ? kind : null,
          typeof x[4] === 'boolean'
            ? x[4]
            : null,
          r1(x[5]),
          type,
        ]),
      )
    }
  }
  return zlib.gzipSync(`${out.join('\n')}\n`)
}
