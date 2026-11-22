// The settings page's script (homebridge-ui/public/index.html loads it). The same page is used by the plugin's own web page
// (lib/web.js), where window.homebridge is a stand-in that talks to /api/hb.
;(() => {
  const $ = s => document.querySelector(s)
  const $$ = s => [
    ...document.querySelectorAll(s),
  ]
  const esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
      })[c],
    )
  const W = w => (w == null
    ? '–'
    : Math.abs(w) >= 1000
      ? `${(w / 1000).toFixed(2)} kW`
      : `${Math.round(w)} W`)
  const kWh = k => (k >= 100
    ? `${Math.round(k)} kWh`
    : k >= 10
      ? `${k.toFixed(1)} kWh`
      : `${k.toFixed(2)} kWh`)
  // the plugin's sums against the meter's own count (V.health.check)
  const within = c =>
    Math.abs(c.pct) < 0.5
      ? 'within 0.5% of'
      : `${Math.abs(c.pct).toFixed(1)}% ${c.pct > 0
        ? 'above'
        : 'below'}`
  const ago = (t) => {
    if (!t) {
      return '–'
    }
    const s = (Date.now() - t) / 1000
    return s < 90
      ? 'just now'
      : s < 5400
        ? `${Math.round(s / 60)} min ago`
        : s < 129600
          ? `${Math.round(s / 3600)} h ago`
          : `${Math.round(s / 86400)} days ago`
  }
  const cycleName = c => (c.sure
    ? c.name
    : `probably ${c.name}`)
  const dur = s =>
    s == null
      ? ''
      : s >= 3600
        ? `${(s / 3600).toFixed(1)} h`
        : `${Math.max(1, Math.round(s / 60))} min`
  const plural = (n, w, ws) => `${n} ${n === 1
    ? w
    : ws || `${w}s`}`
  const SRC = { set: 'your figure', learned: 'learned', default: 'default' }
  const TILE = {
    none: 'None',
    faucet: 'Faucet (shows Running)',
    switch: 'Switch',
    outlet: 'Outlet',
    light: 'Light',
    fan: 'Fan',
    purifier: 'Air purifier',
    humidifier: 'Humidifier',
    dehumidifier: 'Dehumidifier',
    heater: 'Heater',
    cooler: 'Air conditioner',
    occupancy: 'Occupancy sensor',
    contact: 'Contact sensor',
    motion: 'Motion sensor',
  }
  const HB = window.homebridge
  let sumBy = 'appl' // Where it went: by appliance or by room
  let FOUND = null
  let finding = false // Find Shellys: the last result, kept while the page is open
  let V = null
  let busy = false
  let roomsEditing = false
  let otherDraft = null
  let editing = null
  let naming = null
  let sumDays = 1
  let planDraft = null
  let S1 = null
  let allTips = false

  // which headings are open is remembered on this browser (Today open the first time)
  const OPEN_KEY = 'home-energy-open'
  try {
    const o = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null')
    if (o) {
      for (const d of $$('details.sec')) d.open = !!o[d.id]
    }
  } catch {}
  $$('details.sec').forEach(d =>
    d.addEventListener('toggle', () => {
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries($$('details.sec').map(x => [x.id, x.open]))))
      } catch {}
      if (d.id === 'sec-today' && d.open) {
        renderSummary()
      }
    }),
  )
  // Appliances → + Add a device: the find and add forms, shown or hidden
  function addDev(show = $('#addDev').style.display === 'none') {
    $('#addDev').style.display = show ? '' : 'none'
    $('#addDevBtn').setAttribute('aria-expanded', String(show))
  }
  // the device list in Settings, showing only the ones not connected
  function showProblems() {
    if (folded.hw) {
      toggleFold('hw')
    }
    F.dshow = 'problem'
    $('#dshow').value = 'problem'
    saveF()
    renderDev()
    openSec('sec-set')
    $('#card-hw').scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }
  const openSec = (id) => {
    const d = $(`#${id}`)
    if (!d.open) {
      d.open = true
    }
    d.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }

  // ---------- talking to the plugin ----------
  async function call(action, args = {}, quiet = false) {
    const r = await HB.request('/call', { action, args })
    if (r.notRunning) {
      showNotRunning(r.error)
    }
    if (!r.ok) {
      if (!quiet) {
        HB.toast.error(r.error, 'Shelly Home Energy')
      }
      throw Object.assign(new Error(r.error), { shown: true })
    }
    return r.result
  }
  async function act(action, args, okMsg) {
    try {
      const r = await call(action, args)
      if (okMsg) {
        HB.toast.success(okMsg, 'Shelly Home Energy')
      }
      await refresh(true)
      return r
    } catch (e) {
      if (!e.shown) {
        HB.toast.error(e.message, 'Shelly Home Energy')
      }
      return undefined
    }
  }
  // the plugin isn't running. On a fresh install that's because config.json has no block for it yet (Homebridge only starts a
  // platform plugin that has one, and only then offers Bridge Settings): offer to add it here
  async function showNotRunning(msg) {
    const n = $('#notRunning')
    n.style.display = ''
    let blocks = null
    if (!HB.web) {
      try {
        blocks = await HB.getPluginConfig()
      } catch {}
    }
    const steps = '<ol style="margin:.4rem 0 0 1.1rem;padding:0"><li>Restart Homebridge.</li><li>On the Plugins tab, open this plugin\'s <b>⋮</b> menu → <b>Bridge Settings</b>: turn on its child bridge and <b>Matter</b> (and <b>HomeKit</b> for the running tiles), Save, and restart Homebridge again.</li><li>Add the bridge in the Home app (<b>+ → Add Accessory</b>) with the pairing code shown for it in the Homebridge UI, then reload this page.</li></ol>'
    if (setupDone) {
      put('#notRunning', `<b>Set up.</b> Now:${steps}`)
    } else if (Array.isArray(blocks) && !blocks.length) {
      put(
        '#notRunning',
        `<b>Welcome! One step before this page can work.</b> Homebridge only starts this plugin once it has its settings in config.json, and only then offers it a child bridge.
      <div class="gap" style="margin:.5rem 0"><button class="btn btn-primary btn-sm" id="firstSetup">Set up the plugin</button></div><span class="muted">Then:</span>${steps}`,
      )
    } else {
      put(
        '#notRunning',
        `${esc(msg)}${HB.web
          ? ''
          : '<div class="muted" style="margin-top:.3rem">If this is a new install: check that it has a child bridge (Plugins → <b>⋮</b> → Bridge Settings) and that the child bridge is running, then reload this page.</div>'}`,
      )
    }
  }
  let setupDone = false
  async function firstSetup() {
    try {
      await saveConfig([
        { platform: 'ShellyHomeEnergy', name: 'Shelly Home Energy' },
      ])
      setupDone = true
      HB.toast.success(
        typeof HB.savePluginConfig === 'function'
          ? 'Added to config.json. Restart Homebridge, then set up its child bridge.'
          : 'Press Save below to add it to config.json, then restart Homebridge.',
        'Shelly Home Energy',
      )
      showNotRunning('')
    } catch (e) {
      HB.toast.error(e.message, 'Shelly Home Energy')
    }
  }
  async function refresh(force = false) {
    if (busy && !force) {
      return
    }
    busy = true
    try {
      V = await call('view', ICONP
        ? {}
        : { icons: true }, true)
      if (V.plugin.icons) {
        ICONP = V.plugin.icons
        ICON_NAMES = V.plugin.iconLabels || {}
      }
      $('#notRunning').style.display = 'none'
      render()
    } catch (e) {
      if (!V) {
        $('#status').innerHTML = '<span class="dot"></span>Not connected to the plugin.'
      }
    } finally {
      busy = false
    }
  }
  // only redraw a part when its content changed and nothing in it is being typed in
  // parts of Today that can be folded away (Ways to save, Where it went): just their heading, remembered in this browser
  const FOLD_KEY = 'home-energy-folded'
  const FOLDABLE = { week: 'Last 7 days by hour', tips: 'Ways to save', summary: 'Where it went' }
  let folded = {}
  try {
    folded = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}
  } catch {}
  function foldable(id, html) {
    const m = html.match(/^\s*<h6 class="sub2">([\s\S]*?)<\/h6>/)
    if (!m) {
      return html
    }
    const shut = !!folded[id]
    return `<h6 class="sub2 foldh" data-fold="${id}" role="button" tabindex="0" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} ${FOLDABLE[id]}"><span class="caret">${shut ? '▸' : '▾'}</span>${shut
      ? `${FOLDABLE[id]} <span class="muted" style="font-weight:400;font-size:.85em">· hidden, tap to show</span>`
      : m[1]}</h6>${shut
      ? ''
      : html.slice(m[0].length)}`
  }
  function toggleFold(id) {
    folded[id] = !folded[id]
    if (!folded[id]) {
      delete folded[id]
    }
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folded))
    } catch {}
    const box = $(`[data-foldwrap="${id}"]`)
    if (box) {
      box.classList.toggle('folded', !!folded[id])
      box.querySelector('.foldh')?.setAttribute('aria-expanded', String(!folded[id]))
      return
    }
    const el = $(`#${id}`)
    el._html = null
    el._raw = null
    if (id === 'tips') {
      renderTips()
    } else if (id === 'week') {
      renderWeek()
    } else {
      renderSummary()
    }
  }
  // the folds that are part of the page itself: as they were left
  setTimeout(() => applyFolds())
  function applyFolds() {
    for (const b of $$('[data-foldwrap]')) {
      const f = !!folded[b.dataset.foldwrap]
      b.classList.toggle('folded', f)
      b.querySelector('.foldh')?.setAttribute('aria-expanded', String(!f))
    }
  }
  // force: redraw even with a box in it selected (after the user changed something there themselves)
  function put(el, html, force = false) {
    if (typeof el === 'string') {
      el = $(el)
    }
    if (!el) {
      return
    }
    if (FOLDABLE[el.id]) {
      html = foldable(el.id, html)
    }
    if (el._html === html) {
      return
    }
    if (!force && el.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      return
    }
    if (!force && el.closest('[data-savecard].dirty')) {
      return
    } // a Settings card with changes not saved yet keeps them
    el.innerHTML = html
    el._html = html
  }
  // an appliance's icon: a Google Material Symbol, drawn from the paths the plugin sends once (lib/icons.js). None chosen = bolt,
  // "No icon" ('none') = nothing (the space is kept in lists so names line up)
  let ICONP = null
  const icon = name =>
    name === 'none' || !ICONP
      ? ''
      : `<svg viewBox="0 0 24 24" aria-hidden="true" data-i="${esc(ICONP[name] ? name : 'bolt')}"><path d="${esc(ICONP[name] || ICONP.bolt)}"/></svg>`
  let ICON_NAMES = {} // plain names for the icons (lib/icons.js ICON_LABELS), sent with them
  const iconLabel = k => ICON_NAMES[k] || k.replace(/_/g, ' ')
  const ico = name => `<span class="ico">${icon(name)}</span>`
  const iconSelect = (id, cur) =>
    `<div class="gap" style="flex-wrap:nowrap"><span class="ico" data-icoprev>${icon(cur || '')}</span><select class="form-control" id="${id}" data-iconsel><option value=""${!cur
      ? ' selected'
      : ''}>Automatic</option><option value="none"${cur === 'none'
      ? ' selected'
      : ''}>No icon</option>${Object.keys(
      ICONP || {},
    )
      .filter(k => ![
        'help',
        'settings',
        'today',
        'home',
        'warning',
      ].includes(k))
      .sort((a, b) => iconLabel(a).localeCompare(iconLabel(b)))
      .map(k => `<option value="${k}"${k === cur
        ? ' selected'
        : ''}>${esc(iconLabel(k))}</option>`)
      .join('')}</select></div>`
  // rooms in the order set with Edit rooms (Your appliances) (A–Z until it's been set); "No room" always last
  const roomSort = (a, b) => {
    const R = V.settings.rooms
    const o = V.settings.roomsOrdered
    if (!a || !b) {
      return !a - !b
    }
    const i = o
      ? R.indexOf(a)
      : -1
    const j = o
      ? R.indexOf(b)
      : -1
    return (i < 0) - (j < 0) || (i >= 0 && j >= 0
      ? i - j
      : a.localeCompare(b))
  }
  // the room picker: No room, your rooms, and "+ New room…" which opens a box to type the new one's name
  const roomPicker = (id, cur) => {
    const rooms = [
      ...new Set([
        ...V.settings.rooms,
        ...(cur
          ? [cur]
          : []),
      ]),
    ].sort(roomSort)
    return `<div data-roompick="${esc(id)}"><select class="form-control" data-roomsel><option value=""${!cur
      ? ' selected'
      : ''}>No room</option>${rooms.map(r => `<option value="${esc(r)}"${r === cur
      ? ' selected'
      : ''}>${esc(r)}</option>`).join('')}<option value="__new">+ New room…</option></select>
      <input class="form-control" data-roomnew maxlength="40" placeholder="New room's name, e.g. Laundry" style="display:none;margin-top:.35rem" autocomplete="off"></div>`
  }
  // what a picker holds: the chosen room, or the new one typed (null if "New room" was chosen and left empty)
  const roomOf = (id) => {
    const w = $(`[data-roompick="${CSS.escape(id)}"]`)
    if (!w) {
      return undefined
    }
    const v = w.querySelector('[data-roomsel]').value
    return v === '__new'
      ? w.querySelector('[data-roomnew]').value.trim() || null
      : v
  }
  const money = v => (V?.settings.currency || '$') + (v >= 100
    ? Math.round(v)
    : v.toFixed(2))

  // ---------- questions on the page (the browser's own are blocked in the Homebridge UI) ----------
  let asking = null
  function ask(anchor, text, { input = null, placeholder = '', ok = 'OK', danger = false } = {}) {
    asking?.done(null)
    return new Promise((resolve) => {
      const box = document.createElement('div')
      box.className = 'ask'
      box.innerHTML = `<p>${esc(text)}</p>${input !== null
        ? `<input class="form-control" data-askin value="${esc(input)}" placeholder="${esc(placeholder)}" autocomplete="off" style="margin-bottom:.5rem">`
        : ''}
        <div class="gap"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-askok>${esc(ok)}</button><button class="btn btn-secondary btn-sm" data-askno>Cancel</button></div>`
      const row = anchor?.closest('tr')
      let holder = box
      if (row) {
        holder = document.createElement('tr')
        const td = document.createElement('td')
        td.colSpan = 20
        td.appendChild(box)
        holder.appendChild(td)
        row.after(holder)
      } else {
        (anchor?.closest('.gap, p, .row2, div') || $('#he')).after(holder)
      }
      const field = box.querySelector('[data-askin]')
      const done = (v) => {
        if (asking?.box !== box) {
          return
        }
        asking = null
        holder.remove()
        resolve(v)
      }
      asking = { box, done }
      box.querySelector('[data-askok]').onclick = () => done(field
        ? field.value.trim()
        : true)
      box.querySelector('[data-askno]').onclick = () => done(null)
      if (field) {
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            done(field.value.trim())
          }
          if (e.key === 'Escape') {
            done(null)
          }
        })
      }
      ;(field || box.querySelector('[data-askok]')).focus()
      holder.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    })
  }

  // ---------- drawing ----------
  function render() {
    if (asking) {
      return
    } // never redraw with a question open
    put(
      '#status',
      `<span><span class="dot ${V.em.ok
        ? 'ok'
        : V.em.msg === 'Connecting…'
          ? 'wait'
          : ''}"></span>Meter: ${esc(V.em.msg)}</span>
      <span><span class="dot ${V.tiles.matterOn ? 'ok' : ''}"></span>Matter ${V.tiles.matterOn
    ? `on (${plural(V.tiles.outlets, 'outlet')})`
    : 'off for this bridge'}</span>
      <span><span class="dot ${V.tiles.hapOn ? 'ok' : 'wait'}"></span>HomeKit ${V.tiles.hapOn ? 'on' : 'off (running tiles need it)'}</span>${HB.web && V.web?.readOnly
    ? '<span class="muted">· View only</span>'
    : ''}`,
    )
    $('#he').classList.toggle('ro', !!(HB.web && V.web?.readOnly))
    for (const el of $$('[data-secico]')) {
      if (!el.innerHTML && ICONP) {
        el.innerHTML = icon(el.dataset.secico)
      }
    }
    renderToday()
    renderCurve()
    renderWeek()
    if (!naming) {
      renderPat()
    }
    if (!editing) {
      renderAppl()
    }
    renderSettings()
    renderFound()
    put('#foot', `${esc(V.plugin.name)} ${esc(V.plugin.version)} · everything stays on your home network`)
  }
  const notAnswering = () =>
    V.shelly.filter(s => s.ok === false).length
    + V.matter.filter(m => ['failed', 'offline'].includes(m.status)).length
  // why switches of a device that doesn't measure couldn't be used to learn its watts, most common first
  const SKIP_WHY = {
    busy: 'something else changed at the same moment',
    noisy: 'the house reading was too jumpy',
    readings: 'no meter readings around it',
    late: 'the switch was reported late',
    wrongway: 'the house reading went the other way',
  }
  function skipWhy(e) {
    const w = Object.entries(e.why || {})
      .filter(([k, n]) => SKIP_WHY[k] && n > 0)
      .sort((a, b) => b[1] - a[1])
    if (!w.length) {
      return ''
    }
    const tip
      = w[0][0] === 'busy'
        ? 'Switch it a few times while little else is running.'
        : w[0][0] === 'noisy'
          ? 'Switch it when the heat pump, spa or other big loads are off.'
          : w[0][0] === 'readings'
            ? 'Check the whole-house meter is answering.'
            : ''
    return `${w.map(([k, n]) => `${n}: ${SKIP_WHY[k]}`).join('; ')}. ${tip}`
  }

  // ---------- the power graph on Today ----------
  const hhmm = (t) => {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const G = {
    W: 640,
    H: 180,
    L: 46,
    R: 10,
    T: 10,
    B: 22,
  }
  function renderCurve() {
    const c = V.curve
    if (!c || !c.today.some(x => x != null)) {
      put('#curveHead', '')
      put('#curveTip', '')
      put('#gauge', '')
      return put(
        '#curveSvg',
        '<p class="muted" style="margin:.4rem 0">The power graph starts with the first readings from the meter.</p>',
      )
    }
    // a phone: a narrower drawing, so its labels stay readable when it's scaled to fit
    const narrow = ($('#curveSvg')?.clientWidth || 640) < 500
    G.W = narrow ? 360 : 640
    G.H = narrow ? 210 : 180
    G.L = narrow ? 40 : 46
    const slots = Math.max(c.yesterday?.length || 0, Math.round(86400e3 / c.step))
    const all = [
      ...c.today,
      ...(c.yesterday || []),
      c.base || 0,
    ].filter(x => x != null)
    const top = Math.max(100, ...all) * 1.08
    const nice = [
      100,
      200,
      250,
      500,
      1000,
      2000,
      2500,
      5000,
      10000,
      20000,
    ].find(s => top / s <= 5) || 50000
    const ymax = Math.ceil(top / nice) * nice
    const x = i => G.L + (i * (G.W - G.L - G.R)) / (slots - 1)
    const y = w => G.T + (1 - w / ymax) * (G.H - G.T - G.B)
    const segs = (arr) => {
      const out = []
      let cur = []
      arr.forEach((w, i) => {
        if (w == null) {
          if (cur.length) {
            out.push(cur)
          }
          cur = []
        } else {
          cur.push([
            x(i),
            y(w),
          ])
        }
      })
      if (cur.length) {
        out.push(cur)
      }
      return out
    }
    const line = arr =>
      segs(arr)
        .map(sg => `M${sg.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L')}`)
        .join(' ')
    const area = arr =>
      segs(arr)
        .map(
          sg =>
            `M${sg[0][0].toFixed(1)} ${y(0).toFixed(1)} L${
              sg.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L')
            } L${sg.at(-1)[0].toFixed(1)} ${y(0).toFixed(1)} Z`,
        )
        .join(' ')
    const grid = Array.from({ length: Math.round(ymax / nice) + 1 }, (_, k) => k * nice)
      .map(
        w =>
          `<line x1="${G.L}" x2="${G.W - G.R}" y1="${y(w).toFixed(1)}" y2="${y(w).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/><text x="${G.L - 6}" y="${(y(w) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity=".6">${w >= 1000
            ? `${w / 1000} kW`
            : `${w} W`}</text>`,
      )
      .join('')
    const hourTicks = [0, 6, 12, 18, 24]
      .map(
        h =>
          `<text x="${Math.min(x((h * 3600e3) / c.step), G.W - G.R).toFixed(1)}" y="${G.H - 6}" text-anchor="${h === 24
            ? 'end'
            : h ? 'middle' : 'start'}" font-size="10" fill="currentColor" fill-opacity=".6">${String(h).padStart(2, '0')}:00</text>`,
      )
      .join('')
    const li = c.today.reduce((k, w, i) => (w != null
      ? i
      : k), -1)
    const last = c.today[li]
    const svg = `<svg viewBox="0 0 ${G.W} ${G.H}" role="img" aria-label="Whole-house power today${c.yesterday ? ', with yesterday' : ''}">${grid}${hourTicks}
      ${c.yesterday
    ? `<path d="${line(c.yesterday)}" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="1.3" stroke-linejoin="round"/>`
    : ''}
      ${c.base
    ? `<line x1="${G.L}" x2="${G.W - G.R}" y1="${y(c.base).toFixed(1)}" y2="${y(c.base).toFixed(1)}" stroke="var(--warn)" stroke-opacity=".7" stroke-dasharray="6 4"/>`
    : ''}
      <path d="${area(c.today)}" fill="#3b82f6" fill-opacity=".15"/><path d="${line(c.today)}" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="${x(li).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="#3b82f6"/></svg>`
    put(
      '#curveHead',
      `<h6 class="sub2" style="margin-bottom:.2rem">Power today</h6><div class="muted" style="font-size:.85em;margin-bottom:.4rem">${c.peak
        ? `Peak ${W(c.peak.w)} at ${hhmm(c.peak.t)} · `
        : ''}<span style="color:#3b82f6">━</span> today${c.yesterday ? ' · <span style="opacity:.45">━</span> yesterday' : ''}${c.base
        ? ` · <span style="color:var(--warn)">┄</span> always on, about ${W(c.base)}`
        : ''}</div>`,
    )
    put('#gauge', gauge(V.now?.p ?? null, ymax)) // the dial's scale is the graph's own top, so the two read alike
    put('#curveSvg', svg)
    if (!G.hover) {
      put('#curveTip', '')
    } // shows the watts at a time only while the graph is pointed at
  }
  // Last 7 days by hour: one row a day, one cell an hour, shaded in the graph's blue by how much the house used then (or, with
  // a plan, what it cost). With a plan, a mark under each hour shows which rate it was on that day, cheapest in light blue.
  const WK_KEY = 'home-energy-week-mode'
  let wkMode = (() => {
    try {
      return localStorage.getItem(WK_KEY) === 'cost'
        ? 'cost'
        : 'kwh'
    } catch {
      return 'kwh'
    }
  })()
  function renderWeek() {
    const D = (V.week || []).filter(d => d.h)
    if (!D.some(d => d.h.some(v => v > 0))) {
      return put('#week', '')
    }
    // a phone: two hours a cell, so the cells stay big enough to read and tap
    const step = ($('#week')?.clientWidth || 800) < 520
      ? 2
      : 1
    const N = 24 / step
    const sum2 = (a, j) => {
      let v = null
      for (let k = j * step; k < (j + 1) * step; k++) {
        if (a[k] != null) {
          v = (v || 0) + a[k]
        }
      }
      return v
    }
    const plan = D.some(d => d.p)
    const cost = plan && wkMode === 'cost'
    const val = (d, j) => {
      if (!cost) {
        return sum2(d.h, j)
      }
      let v = null
      for (let k = j * step; k < (j + 1) * step; k++) {
        if (d.h[k] != null) {
          v = (v || 0) + d.h[k] * (d.p?.[k] || 0)
        }
      }
      return v
    }
    const all = D.flatMap(d => Array.from({ length: N }, (_, j) => val(d, j))).filter(v => v != null)
    const max = Math.max(...all, 1e-6)
    const name = (k) => {
      const [y, m, dd] = k.split('-').map(Number)
      return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
    }
    const amount = v => (cost
      ? money(v)
      : v < 1
        ? `${Math.round(v * 1000)} Wh`
        : kWh(v))
    const rateText = pr => (V.settings.currency || '$') + String(+pr.toFixed(4)) // a rate as the plan has it: $0.1795, $0.265
    const hh = j => String(j * step).padStart(2, '0')
    // the plan's rates, cheapest first, each named from the plan (Day, Night, Weekend…), in blues apart from the cells' own
    const T = V.settings.tariff
    const tf = T.taxIncl === false
      ? 1 + (T.tax || 0) / 100
      : 1
    const nameOf = new Map()
    if (plan) {
      for (const p of T.periods || []) nameOf.set(Math.round(p.rate * tf * 1e5) / 1e5, p.name)
      const base = Math.round((T.rate || 0) * tf * 1e5) / 1e5
      if (!nameOf.has(base)) {
        nameOf.set(base, T.mode === 'tou'
          ? 'Day'
          : 'Rate')
      }
    }
    const prices = plan
      ? [
          ...new Set(D.flatMap(d => d.p || [])),
        ].sort((a, b) => a - b)
      : []
    const tint = pr =>
      prices.length < 2
        ? 'transparent'
        : pr === prices[0]
          ? '#7dd3fc'
          : pr === prices.at(-1)
            ? '#6366f1'
            : '#a5b4fc'
    // the rates shown once, as a strip over the hours (today's); a day whose rates differ (a weekend rate) gets its own marks
    const ref = D.at(-1).p
    const rateAt = (p, j) => p?.[j * step]
    const same = p => !p || !ref || p.every((x, k) => x === ref[k])
    const strip
      = prices.length > 1
        ? `<div></div>${Array.from({ length: N }, (_, j) => `<div class="r" style="background:${tint(rateAt(ref, j))}" title="${esc(`${hh(j)}:00 · ${nameOf.get(rateAt(ref, j)) || 'rate'} ${rateText(rateAt(ref, j))}/kWh`)}"></div>`).join('')}<div></div>`
        : ''
    const cell = (d, j) => {
      const v = val(d, j)
      const pr = rateAt(d.p, j)
      const mark = prices.length > 1 && !same(d.p)
        ? `;box-shadow:inset 0 -3px 0 ${tint(pr)}`
        : ''
      const label = `${name(d.day)} ${hh(j)}:00–${String((j + 1) * step).padStart(2, '0')}:00${pr != null && prices.length > 1
        ? ` · ${nameOf.get(pr) || 'rate'} ${rateText(pr)}/kWh`
        : ''}`
      return v == null
        ? `<div class="c" style="border:1px dashed var(--line)${mark}" title="${esc(label)}"></div>`
        : `<div class="c" style="background:rgba(59,130,246,${(0.08 + 0.92 * Math.sqrt(v / max)).toFixed(2)})${mark}" title="${esc(label)} · ${esc(amount(v))}"></div>`
    }
    const head = `<div></div>${Array.from({ length: N }, (_, j) => `<div class="h">${(j * step) % (step === 2
      ? 6
      : 3)
      ? ''
      : hh(j)}</div>`).join('')}<div class="t">${cost ? 'cost' : 'kWh'}</div>`
    const rows = D.map(
      d =>
        `<div class="d">${esc(name(d.day))}</div>${Array.from({ length: N }, (_, j) => cell(d, j)).join('')}<div class="t">${cost
          ? money(d.h.reduce((a, v, j) => a + (v || 0) * (d.p?.[j] || 0), 0))
          : d.h.reduce((a, v) => a + (v || 0), 0).toFixed(1)}</div>`,
    ).join('')
    const legend
      = prices.length > 1
        ? `${prices
          .map(
            pr =>
              `<span style="white-space:nowrap"><span style="display:inline-block;width:1.2em;height:4px;border-radius:2px;vertical-align:middle;background:${tint(pr)}"></span> ${esc(nameOf.get(pr) || 'Rate')} ${esc(rateText(pr))}</span>`,
          )
          .join(' · ')} per kWh`
        : ''
    put(
      '#week',
      `<h6 class="sub2">Last 7 days by hour</h6>
      ${
  plan
    ? `<div class="gap" style="margin-bottom:.5rem"><div class="seg">${[
      ['kwh', 'Energy'],
      ['cost', 'Cost'],
    ]
      .map(
        ([k, l]) =>
          `<button class="btn btn-sm ${k === wkMode
            ? 'btn-secondary'
            : 'btn-outline-secondary'}" data-wkmode="${k}">${l}</button>`,
      )
      .join('')}</div>
        <span class="muted" style="font-size:.8em">${legend}</span></div>`
    : ''
  }
      <div class="wk" style="grid-template-columns:4.2em repeat(${N}, minmax(0, 1fr)) 4.5em">${head}${strip}${rows}</div>
      ${cost ? '<div class="muted" style="font-size:.8em;margin-top:.4rem">Daily charges aren\'t included.</div>' : ''}`,
    )
  }
  const BLUE = '#3b82f6' // today's line on the graph, and the dial with it
  // a dial for the whole house now: a half ring shading from strong (0) to faint (the top of the scale), a needle, the figure under it
  function gauge(w, max) {
    const f = w == null
      ? 0
      : Math.max(0, Math.min(1, w / max))
    const a = Math.PI * (1 - f)
    const b = a + Math.PI / 2
    const cx = 100
    const cy = 100
    const R = 88
    const r = 60
    const N = 60
    const pt = (a, rad) => [cx + rad * Math.cos(a), cy - rad * Math.sin(a)].map(v => v.toFixed(2)).join(' ')
    const segs = Array.from({ length: N }, (_, k) => {
      const a0 = Math.PI * (1 - k / N)
      const a1 = Math.PI * (1 - (k + 1) / N) - 0.004
      const on = (k + 0.5) / N <= f // up to the watts now: the graph's blue, deepening towards the top of the scale, like its line
      return `<path d="M${pt(a0, R)} A${R} ${R} 0 0 1 ${pt(a1, R)} L${pt(a1, r)} A${r} ${r} 0 0 0 ${pt(a0, r)}Z" fill="${on ? BLUE : 'currentColor'}" fill-opacity="${on
        ? (0.35 + (0.65 * k) / (N - 1)).toFixed(2)
        : '.12'}"/>`
    }).join('')
    const needle
      = w == null
        ? ''
        : `<g mask="url(#gHub)" fill="currentColor"><path d="M${pt(a, 78)} L${(cx + 11 * Math.cos(b)).toFixed(2)} ${(cy - 11 * Math.sin(b)).toFixed(2)} L${(cx - 11 * Math.cos(b)).toFixed(2)} ${(cy + 11 * Math.sin(b)).toFixed(2)}Z"/><circle cx="${cx}" cy="${cy}" r="13"/></g>`
    return `<svg viewBox="0 0 200 122" width="190" role="img" aria-label="Whole house now: ${w == null
      ? 'no reading'
      : W(w)}"><defs><mask id="gHub"><rect width="200" height="122" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="6.5" fill="#000"/></mask></defs>
      ${segs}<rect x="${cx - R}" y="${cy}" width="${R - r}" height="9" fill="${w != null && w > 0
    ? BLUE
    : 'currentColor'}" fill-opacity="${w != null && w > 0
    ? '.35'
    : '.12'}"/><rect x="${cx + r}" y="${cy}" width="${R - r}" height="9" fill="${f >= 1
    ? BLUE
    : 'currentColor'}" fill-opacity="${f >= 1
    ? '1'
    : '.12'}"/>${needle}
      <text x="${cx - R + 14}" y="121" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".7">0</text><text x="${cx + R - 14}" y="121" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".7">${max >= 1000
    ? `${max / 1000} kW`
    : `${max} W`}</text></svg>
      <div style="text-align:center;margin-top:-.2rem"><span class="big gval" style="color:${BLUE}">${w == null
    ? '–'
    : W(w)}</span> <span class="muted">now</span></div>`
  }
  // point at the graph: the watts at that time, today and yesterday
  function curveTip(ev) {
    const c = V?.curve
    const svg = $('#curveSvg svg')
    if (!c || !svg) {
      return
    }
    const r = svg.getBoundingClientRect()
    const px = (((ev.touches?.[0] || ev).clientX - r.left) * G.W) / r.width
    const slots = Math.max(c.yesterday?.length || 0, Math.round(86400e3 / c.step))
    const i = Math.round(((px - G.L) * (slots - 1)) / (G.W - G.L - G.R))
    if (i < 0 || i >= slots) {
      return
    }
    G.hover = true
    const t = c.start + i * c.step
    const a = c.today[i]
    const b = c.yesterday?.[i]
    $('#curveTip').textContent
      = `${hourText(t)}: ${a != null
        ? `today ${W(a)}`
        : i < c.today.length
          ? 'today: no reading'
          : 'later today'}${b != null
        ? ` · yesterday ${W(b)}`
        : ''}`
    $('#curveTip')._html = null
  }
  document.addEventListener('mousemove', (ev) => {
    if (ev.target.closest?.('#curveSvg')) {
      curveTip(ev)
    } else if (G.hover) {
      G.hover = false
      if (V) {
        renderCurve()
      }
    }
  })
  document.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.target.closest?.('#curveSvg')) {
        curveTip(ev)
      }
    },
    { passive: true },
  )

  // dismissed to-do items: key → when, kept in this browser for a day
  const TODO_KEY = 'home-energy-todo-dismissed'
  const todoGone = () => {
    try {
      const o = JSON.parse(localStorage.getItem(TODO_KEY) || '{}') || {}
      for (const k in o) {
        if (Date.now() - o[k] > 86400e3) {
          delete o[k]
        }
      }
      return o
    } catch {
      return {}
    }
  }
  function renderToday() {
    const todo = []
    if (!V.settings.em.host) {
      todo.push([
        'sec-set',
        'Add the Shelly EM\'s address',
        'Settings → Whole-house meter',
        'meter-host',
      ])
    } else if (!V.em.ok && V.em.msg !== 'Connecting…') {
      todo.push([
        'sec-set',
        `The meter isn't connected: ${V.em.msg}`,
        'Settings → Whole-house meter',
        'meter-down',
      ])
    }
    if (!V.tiles.matterOn) {
      todo.push([
        '',
        'Turn on Matter for this plugin\'s bridge (the main bridge in Settings, or Plugins → ⋮ → Bridge Settings for a child bridge) and restart',
        '',
        'matter-off',
      ])
    }
    if (V.patterns.length) {
      todo.push([
        'sec-appl',
        `${plural(V.patterns.length, 'repeating step')} to name`,
        'Appliances',
        `steps:${V.patterns.length}`,
      ])
    }
    for (const x of V.sigs.filter(x => x.longRun)) {
      todo.push([
        'sec-appl',
        `${withRoom(x.name, x.room)} has been running ${dur(x.longRun.el)}; it usually takes about ${dur(x.longRun.usual)}`,
        'worth a look',
        `long:${x.id}:${Math.round((Date.now() - x.longRun.el * 1000) / 600e3)}`,
      ])
    }
    const na = notAnswering()
    if (na) {
      todo.push([
        'devprob',
        `${plural(na, 'device')} not connected`,
        'Settings → Shellys and Matter devices',
        `na:${na}`,
      ])
    }
    const nf = foundReadings().filter(d => !d.hidden).length
    if (nf) {
      todo.push([
        'sec-appl',
        `${plural(nf, 'device')} found, not set up yet`,
        'Appliances',
        `found:${nf}`,
      ])
    }
    const relink = V.sigs.filter(s => s.relink).length
    if (relink) {
      todo.push([
        'sec-appl',
        `${plural(relink, 'appliance')} measured through another Homebridge plugin before: link each to its device, or keep it on steps`,
        'Appliances → the ones marked "needs a look" → Edit',
        `relink:${relink}`,
      ])
    }
    // one card above the figures: problems (orange) and next steps (blue), with getting started inside it until setup is done
    let cl = ''
    try {
      cl = localStorage.getItem('home-energy-setup-done') === '1'
        ? 'done'
        : ''
    } catch {}
    const steps = [
      [!!V.settings.em.host && V.em.ok, 'Connect the whole-house meter', 'sec-set'],
      [V.shelly.length + V.matter.length > 0, 'Add your Shellys and Matter devices', 'adddev'],
      [
        !!(V.settings.tariff.rate > 0 || V.settings.tariff.periods?.some(p => p.rate > 0)),
        'Add your electricity plan',
        'sec-set',
      ],
      [V.sigs.length > 0, 'Name or track your first appliance', 'sec-appl'],
    ]
    const showSetup = cl !== 'done' && steps.some(x => !x[0])
    if (showSetup) {
      todo.splice(0, todo.length, ...todo.filter(x => !x[1].startsWith('Add the Shelly EM')))
    }
    // ✕ on an item: hidden for a day, or until it changes (its key: a count, or which run)
    const gone = todoGone()
    todo.splice(0, todo.length, ...todo.filter(x => !gone[x[3]]))
    const PROBLEM = /^(?:meter-down|matter-off|na:|long:)/
    const problems = todo.filter(x => PROBLEM.test(x[3] || ''))
    const next = todo.filter(x => !PROBLEM.test(x[3] || ''))
    const li = ([sec, t, where, key]) =>
      `<li>${sec
        ? `<span class="linky" data-goto="${sec}">${esc(t)}</span>`
        : esc(t)}${where
        ? ` <span class="muted">(${esc(where)})</span>`
        : ''} <button class="btn btn-link btn-sm" data-todogone="${esc(key)}" title="Dismiss">✕</button></li>`
    const setupHtml = showSetup
      ? `<div${problems.length || next.length
        ? ' style="margin-top:.6rem"'
        : ''}><b>Getting started</b> <span class="muted">· ${steps.filter(x => x[0]).length} of ${steps.length} done</span>
      <button class="btn btn-link btn-sm" data-setupdone title="Hide getting started">✕</button><ul class="checklist">${steps.map(([ok, t, go]) => `<li class="${ok ? 'done' : ''}">${ok ? '✓' : '○'} ${ok
    ? esc(t)
    : go === 'adddev'
      ? `<span class="linky" data-adddev>${esc(t)}</span>`
      : `<span class="linky" data-goto="${go}">${esc(t)}</span>`}</li>`).join('')}</ul></div>`
      : ''
    put(
      '#todo',
      problems.length || next.length || showSetup
        ? `<div class="note${problems.length ? ' warn' : ''}" id="attention">
      ${problems.length
    ? `<b><span class="ico" style="width:auto;margin-right:.3em">${icon('warning')}</span>Needs attention</b><ul class="todo-list">${problems.map(li).join('')}</ul>`
    : ''}
      ${next.length
    ? `<b${problems.length ? ' style="display:block;margin-top:.5rem"' : ''}>Next steps</b><ul class="todo-list">${next.map(li).join('')}</ul>`
    : ''}
      ${setupHtml}</div>`
        : '',
    )
    const run = V.sigs.filter(s => s.running).sort((a, b) => b.nowW - a.nowW)
    const t = S1
    const other = V.now?.other
    put(
      '#today',
      `<div class="kpis">
        <div title="${t?.plan ? 'Energy so far today, with the daily charge' : 'Energy so far today'}">${t?.plan
    ? `<div class="k">${money(t.total.cost + t.fixed)}</div><div class="t">today</div><div class="k2">${kWh(t.total.kwh)}</div>`
    : `<div class="k">${t
      ? kWh(t.total.kwh)
      : '–'}</div><div class="t">today</div>`}</div>
        ${monthKpi()}
        <div title="The lowest the house goes in a day"><div class="k">${t?.base != null
    ? `${t.base} W`
    : '–'}</div><div class="t">always on</div>${t?.baseYearKwh
    ? `<div class="k2">about ${Math.round(t.baseYearKwh).toLocaleString()} kWh a year</div>`
    : ''}</div>
        <div title="What your named appliances don't explain"><div class="k">${other != null
    ? W(other)
    : '–'}</div><div class="t">${esc(otherName())} now</div></div></div>
      <div class="muted" style="font-size:.85em;text-align:center">${run.length ? 'Running now' : 'Nothing running that it knows about.'}</div>
      ${run.length
    ? `<div class="running">${run.map(s => `<span class="pill on">${ico(s.icon)}${esc(withRoom(s.name, s.room))}${s.nowW
      ? ` · ${W(s.nowW)}`
      : ''}${s.cycle
      ? ` · ${esc(cycleName(s.cycle))}`
      : ''}${s.remaining != null
      ? ` · ${dur(s.remaining)} left`
      : ''}</span>`).join('')}</div>`
    : ''}`,
    )
    renderTips()
  }
  // this month: so far, and where it's heading (with a budget: whether that's over it)
  // "Other": the name given to it on the Everything else row (Your appliances), used everywhere it appears
  const otherName = () => V?.settings.other?.name || 'Other'
  function monthKpi() {
    const M = V.month
    if (!M || !M.days) {
      return ''
    }
    // calendar months: "November so far"; a bill from another day: "This bill so far (15 Nov – 14 Dec)"
    const dm = (k) => {
      const [y, m, d] = k.split('-').map(Number)
      return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    }
    const name
      = (M.billDay || 1) > 1 && M.from
        ? `This bill (${dm(M.from)} – ${dm(M.to)})`
        : new Date().toLocaleString(undefined, { month: 'long' })
    const C = V.health?.check
    const chk = C
      ? `<div class="k2 muted" title="Over the last ${C.days} days, compared with the meter's own running count">${within(C)} the meter</div>`
      : ''
    if (!M.plan) {
      return `<div><div class="k">${kWh(M.kwh)}</div><div class="t">${esc(name)} so far</div>${M.forecastKwh != null
        ? `<div class="k2">heading for ${kWh(M.forecastKwh)}</div>`
        : ''}${chk}</div>`
    }
    return `<div><div class="k"${M.over ? ' style="color:var(--bad)"' : ''}>${money(M.cost)}</div><div class="t">${esc(name)} so far</div>${M.forecastCost != null || M.budget
      ? `<div class="k2">${M.forecastCost != null
        ? `heading for ${money(M.forecastCost)}`
        : ''}${M.budget
        ? `${M.forecastCost != null
          ? ' · '
          : ''}budget ${money(M.budget)}${M.over ? ' <b style="color:var(--bad)">(over)</b>' : ''}`
        : ''}</div>`
      : ''}${chk}</div>`
  }
  // Ways to save: from this home's own readings only; savings shown per week, month and year
  function renderTips() {
    const I = V.insights
    const shown = I.tips.filter(t => !t.hidden)
    const hidden = I.tips.length - shown.length
    if (!I.tips.length) {
      return put(
        '#tips',
        I.needDays
          ? `<h6 class="sub2">Ways to save</h6><p class="muted" style="font-size:.9em">Tips appear after ${I.needDays} full days of readings (${I.days} so far), from your own appliances.</p>`
          : '',
      )
    }
    const per = t =>
      t.costYear != null
        ? `≈ ${money(t.costYear / 52)} a week · ${money(t.costYear / 12)} a month · ${money(t.costYear)} a year`
        : t.kwhYear != null
          ? `≈ ${(t.kwhYear / 52).toFixed(1)} kWh a week · ${Math.round(t.kwhYear / 12)} kWh a month · ${Math.round(t.kwhYear)} kWh a year`
          : ''
    const list = allTips
      ? shown
      : shown.slice(0, 3)
    const total = shown.filter(t => !t.info).reduce((a, t) => a + (t.costYear ?? 0), 0)
    put(
      '#tips',
      `<h6 class="sub2">Ways to save${I.plan && total >= 1
        ? ` <span class="muted" style="font-weight:400">· up to ${money(total / 12)} a month in all</span>`
        : ''}</h6>
      ${
  list
    .map(
      t => `<div class="tip${t.info ? ' info' : ''}"><div class="tt">${esc(t.title)}<button class="btn btn-link btn-sm" data-tipno="${esc(t.key)}" title="Hide this tip">✕</button></div>
        <div class="tx">${esc(t.text)}</div>${per(t)
    ? `<div class="sv">${per(t)}</div>`
    : ''}</div>`,
    )
    .join('') || '<p class="muted" style="font-size:.9em">Nothing to suggest right now.</p>'
  }
      <div class="gap" style="font-size:.9em">${shown.length > 3
    ? `<button class="btn btn-link btn-sm" data-tipsmore>${allTips
      ? 'Show fewer'
      : `Show all ${shown.length}`}</button>`
    : ''}
        ${hidden
    ? `<button class="btn btn-link btn-sm" data-tipsall>${hidden} hidden · show again</button>`
    : ''}
        <span class="help" style="margin:0">Based on the last ${I.days} days.${I.plan ? '' : ' Add your electricity plan (Settings) to see savings in money.'}</span></div>`,
    )
  }
  // appliances' energy added up per room (its own rows, no icons), largest first; "No room" for the rest
  function byRoom(rows) {
    const m = new Map()
    for (const r of rows) {
      const k = r.room || 'No room'
      const x = m.get(k) || { name: k, kwh: 0, cost: 0, n: 0 }
      x.kwh += r.kwh
      x.cost += r.cost
      x.n++
      m.set(k, x)
    }
    return [
      ...m.values(),
    ]
      .map(x => ({ ...x, key: `room:${x.name}`, name: `${x.name} (${plural(x.n, 'appliance')})` }))
      .sort((a, b) => b.kwh - a.kwh)
  }
  async function renderSummary() {
    if (!$('#sec-today').open) {
      return
    }
    let s
    try {
      s = await call('summary', { days: sumDays }, true)
    } catch {
      return
    }
    if (sumDays === 1) {
      S1 = s
      if (V) {
        renderToday()
      }
    }
    // 7 days: each line against the 7 days before
    let prev = null
    if (sumDays === 7) {
      try {
        prev = await call('summary', { days: 7, back: 7 }, true)
      } catch {}
    }
    const was = new Map()
    if (prev) {
      for (const r of sumBy === 'room'
        ? byRoom(prev.rows)
        : prev.rows) was.set(r.id || r.key, r.kwh)
      was.set('__other', prev.other.kwh)
      was.set('__total', prev.total.kwh)
    }
    const vs = (key) => {
      if (!prev) {
        return ''
      }
      const p = was.get(key)
      const k = cur.get(key) ?? 0
      const cell = t => `<td class="num" style="font-size:.85em">${t}</td>`
      if (!(p > 0.01)) {
        return cell(k > 0.01
          ? '<span class="muted">new</span>'
          : '')
      }
      const d = Math.round(((k - p) / p) * 100)
      return cell(
        Math.abs(d) < 3
          ? '<span class="muted">same</span>'
          : `<span style="color:${d > 0
            ? 'var(--warn)'
            : 'var(--ok)'}">${d > 0
            ? '+'
            : '−'}${Math.abs(d)}%</span>`,
      )
    }
    const lines = sumBy === 'room'
      ? byRoom(s.rows)
      : s.rows
    const cur = new Map([
      ...lines.map(r => [r.id || r.key, r.kwh]),
      ['__other', s.other.kwh],
      ['__total', s.total.kwh],
    ])
    const max = Math.max(0.0001, ...s.rows.map(r => r.kwh), s.other.kwh)
    const c = s.plan
    const row = (name, ic, k, cost, key) =>
      `<tr><td>${ic}${esc(name)}</td><td style="width:30%"><div class="bar" style="width:${Math.round((k / max) * 100)}%"></div></td><td class="num">${kWh(k)}</td>${c
        ? `<td class="num">${money(cost)}</td>`
        : ''}<td class="num muted">${s.total.kwh
        ? `${Math.round((k / s.total.kwh) * 100)}%`
        : ''}</td>${vs(key)}</tr>`
    put(
      '#summary',
      `<h6 class="sub2">Where it went</h6><div class="gap" style="margin-bottom:.6rem"><div class="seg">${[
        [1, 'Today'],
        [7, '7 days'],
        [30, '30 days'],
        [365, 'Year'],
      ]
        .map(
          ([d, l]) =>
            `<button class="btn btn-sm ${d === sumDays
              ? 'btn-primary'
              : 'btn-outline-secondary'}" data-days="${d}">${l}</button>`,
        )
        .join('')}</div>
      <div class="seg" style="margin-left:auto">${[
    ['appl', 'Appliances'],
    ['room', 'Rooms'],
  ]
    .map(
      ([k, l]) =>
        `<button class="btn btn-sm ${k === sumBy
          ? 'btn-secondary'
          : 'btn-outline-secondary'}" data-sumby="${k}">${l}</button>`,
    )
    .join('')}</div></div>
      <div class="scroll"><table><thead><tr><th>${sumBy === 'room'
    ? 'Room'
    : 'Appliance'}</th><th></th><th class="num">Energy</th>${c ? '<th class="num">Cost</th>' : ''}<th class="num">Share</th>${prev ? '<th class="num">vs last week</th>' : ''}</tr></thead><tbody>
      ${lines.map(r => row(sumBy === 'room'
    ? r.name
    : withRoom(r.name, r.room), r.room !== undefined
    ? ico(r.icon)
    : '', r.kwh, r.cost, r.id || r.key)).join('')}${row(V?.settings.other?.name || 'Other', ico('help'), s.other.kwh, s.other.cost, '__other')}
      <tr><td><b>Whole house</b></td><td></td><td class="num"><b>${kWh(s.total.kwh)}</b></td>${c
    ? `<td class="num"><b>${money(s.total.cost)}</b></td>`
    : ''}<td></td>${vs('__total')}</tr>
      ${c && s.fixed
    ? `<tr><td class="muted">Daily charges</td><td></td><td></td><td class="num muted">${money(s.fixed)}</td><td></td>${prev ? '<td></td>' : ''}</tr>`
    : ''}</tbody></table></div>
      ${!c
    ? '<div class="help">Add your electricity plan (Settings) to see costs.</div>'
    : ''}
      ${s.daysWithData < sumDays && sumDays > 1
    ? `<div class="help">Readings for ${s.daysWithData} of these ${sumDays} days.</div>`
    : ''}
      ${s.standby.length
    ? `<p>Using power while idle: ${s.standby.map(x => `${esc(x.name)} <b>${W(x.w)}</b>`).join(', ')}.</p>`
    : ''}`,
    )
  }

  // ----- Appliances: steps to name first (only when there are some), then the list by room -----
  // ----- Appliances: "Found, not set up yet" (repeating steps to name, and device readings not tracked yet) -----
  let allFound = false
  let showHidden = false
  const foundReadings = () =>
    V.devices.filter(d => !d.sensor && !d.tracked && (typeof d.watts === 'number' || typeof d.on === 'boolean'))
  const learnedText = (d) => {
    const e = d.est
    if (typeof d.watts === 'number') {
      return '<span class="muted">measures itself</span>'
    }
    if (!e) {
      return '<span class="muted">Learning its watts: switch it on and off a few times</span>'
    }
    if (e.w == null) {
      return e.small
        ? '<span class="muted">Too small for the meter to see</span>'
        : `<span class="muted">Learning its watts: ${e.n
          ? `${plural(e.n, 'clean switch', 'clean switches')} so far, needs a few more`
          : 'needs a few clean on/off switches'}</span>${e.skip
          ? `<details class="more"><summary>Why ${plural(e.skip, 'switch', 'switches')} couldn't be used</summary><div>${skipWhy(e)}</div></details>`
          : ''}`
    }
    return `about <b>${W(e.w)}</b> <span class="muted">from ${plural(e.used, 'switch', 'switches')}${e.spread > 0.15
      ? ', varies'
      : ''}</span> <button class="btn btn-link btn-sm" data-estreset="${esc(d.id)}" title="Forget these readings">reset</button>`
  }
  const where = d =>
    d.protocol === 'matter'
      ? V.matter.find(m => m.id === d.source)?.name || 'Matter'
      : V.shelly.find(x => x.host === d.host)?.name || d.model || 'Shelly'
  // one label on an appliance that wants attention, with every reason in its tooltip (Edit says more)
  function needsLook(s) {
    const why = [
      s.relink
        ? 'It was measured through another Homebridge plugin before: link it to its device in Edit, or keep it on steps.'
        : '',
      s.varHint
        ? 'Its runs often end without a matching step, like a heat pump or an EV charger: tick "Varies while it runs" in Edit.'
        : '',
      s.sure?.level === 'unsure'
        ? `Not sure yet: ${s.sure.why}`
        : '',
    ].filter(Boolean)
    return why.length
      ? ` <span class="pill warn" data-needslook title="${esc(why.join('\n'))}">needs a look</span>`
      : ''
  }
  // a longer explanation, folded away behind "More about this"
  const more = t => `<details class="more"><summary>More about this</summary><div>${t}</div></details>`
  // the same, as a small ⓘ at the end of a line of text (its text opens below the line)
  const info = t =>
    `<details class="more inl"><summary title="More about this" aria-label="More about this"></summary><div>${t}</div></details>`
  // a Settings section: small heading, one line of description (with its ⓘ), then the rest
  const sec = (head, desc, why, body) =>
    `<div class="psec"><div class="ph">${head}</div><div class="help pdesc">${desc}${why
      ? ` ${info(why)}`
      : ''}</div>${body}</div>`
  // a name shared by appliances in different rooms, with its room: "Downlights · Hall"
  const withRoom = (name, room) =>
    V && V.sigs.filter(x => x.name.trim().toLowerCase() === String(name).trim().toLowerCase()).length > 1
      ? `${name} · ${room || 'No room'}`
      : name
  // " · Hall" after a suggested appliance's name when another appliance has the same name
  const sigRoomTag = (id) => {
    const s = id && V.sigs.find(x => x.id === id)
    return s && V.sigs.some(x => x !== s && x.name.trim().toLowerCase() === s.name.trim().toLowerCase())
      ? ` · ${esc(s.room || 'No room')}`
      : ''
  }
  function renderPat() {
    const P = V.patterns
    const R = foundReadings()
    const shownR = R.filter(d => showHidden || !d.hidden)
    const hidden = R.length - R.filter(d => !d.hidden).length
    const n = P.length + R.filter(d => !d.hidden).length
    put('#sum-appl', n
      ? `${n} to set up`
      : '')
    if (!P.length && !shownR.length && !hidden) {
      return put('#pat', '')
    }
    // one card each: what it is, and the decision (Yes / Name it / ✕, or Track / Hide)
    const steps = P.map(
      p => `<div class="found-card"><span class="fw">${W(p.mean)}</span>
        <span class="fm">${p.kind
    ? `${p.kind === 'r'
      ? 'heater-like'
      : 'motor-like'} · `
    : ''}seen ${p.n}× · last ${ago(p.last)}</span>
        <span class="fa">${p.suggestion
    ? `<span title="${esc(p.suggestion.why)}"><button class="chip" data-yes="${p.key}">${ico(p.suggestion.icon)}${esc(p.suggestion.name)}${sigRoomTag(p.suggestion.sig)}${p.suggestion.part
      ? ' (part of it)'
      : p.suggestion.stage ? ' (stage)' : ''}? <b>Yes</b></button><button class="btn btn-link btn-sm" data-no="${p.key}" title="Not this">✕</button></span>`
    : ''}
          <button class="btn btn-link btn-sm" data-name="${p.key}">Name it</button></span></div>
      ${
  naming === p.key
    ? `<div class="edit"><div class="row2"><div><label class="l">Name</label><input class="form-control" id="nmName" list="sigNames" maxlength="60" placeholder="Kettle"></div><div><label class="l">Icon</label>${iconSelect('nmIcon', p.suggestion?.icon || '')}</div><div><label class="l">Room</label>${roomPicker('nm', '')}</div></div>
        <div class="help">The name and room of an appliance you have adds these steps to it.</div>
        <div class="gap" style="margin-top:.6rem"><button class="btn btn-primary btn-sm" data-doname="${p.key}">Name</button><button class="btn btn-secondary btn-sm" data-cancel>Cancel</button></div></div>`
    : ''
  }`,
    ).join('')
    const list = allFound
      ? shownR
      : shownR.slice(0, 8)
    const reads = list
      .map(
        d => `<div class="found-card"${d.hidden ? ' style="opacity:.6"' : ''}><span style="min-width:10rem"><b>${esc(d.name)}</b><div class="fm">${esc(where(d))}${d.protocol === 'matter'
          ? ' · Matter'
          : ' · Shelly'} · ${!d.reachable
          ? '<span class="err">not connected</span>'
          : typeof d.watts === 'number'
            ? W(d.watts)
            : d.on === true
              ? 'on'
              : d.on === false
                ? 'off'
                : '–'}</div></span>
        <span style="flex:1;min-width:12rem;font-size:.9em">${learnedText(d)}</span>
        <span class="fa"><span class="roomcell" title="Its room. When you track it, the appliance goes in this room.">${roomPicker(`dv-${d.id}`, d.room)}</span>
          <button class="btn btn-link btn-sm" data-track="${esc(d.id)}">Track</button>${d.hidden
    ? `<button class="btn btn-link btn-sm" data-unhide="${esc(d.id)}">Show</button>`
    : `<button class="btn btn-link btn-sm" data-hide="${esc(d.id)}" title="Not an appliance: hide it from this list">Hide</button>`}</span></div>`,
      )
      .join('')
    put(
      '#pat',
      `<div class="note${folded.found ? ' folded' : ''}" data-foldwrap="found" style="margin-top:.2rem"><b class="foldh" data-fold="found" role="button" tabindex="0" title="Show or hide"><span class="caret"></span>Found, not set up yet</b> <span class="muted foldbody">· not counted until you say what it is.</span><span class="muted foldnote">· ${n} to set up, hidden</span><div class="foldbody">
      ${P.length
    ? `<div style="margin-top:.5rem"><b style="font-size:.9em">${plural(P.length, 'repeating power step')}</b> <span class="muted" style="font-size:.9em">· a suggestion is only a guess</span></div>${steps}`
    : ''}
      ${shownR.length
    ? `<div style="margin-top:.7rem"><b style="font-size:.9em">${plural(R.length - hidden, 'device')}</b> <span class="muted" style="font-size:.9em">· track one for its own figures</span></div>${reads}`
    : ''}
      <div class="gap" style="font-size:.9em">${shownR.length > 8
    ? `<button class="btn btn-link btn-sm" data-allfound>${allFound
      ? 'Show fewer'
      : `Show all ${shownR.length}`}</button>`
    : ''}
        ${hidden
    ? `<button class="btn btn-link btn-sm" data-showhidden>${showHidden
      ? 'Hide the hidden ones again'
      : `${hidden} hidden · show`}</button>`
    : ''}</div></div></div>
      <datalist id="sigNames">${V.sigs
    .filter(s => !s.metered)
    .map(s => `<option value="${esc(s.name)}">`)
    .join('')}</datalist>`,
    )
  }
  // ----- filters for the two long lists (remembered on this browser) -----
  const FKEY = 'home-energy-filters'
  const F = (() => {
    try {
      return JSON.parse(localStorage.getItem(FKEY) || '{}') || {}
    } catch {
      return {}
    }
  })()
  const saveF = () => {
    try {
      localStorage.setItem(FKEY, JSON.stringify(F))
    } catch {}
  }
  for (const id of ['aq', 'aroom', 'ashow', 'dq', 'dshow']) {
    const el = $(`#${id}`)
    if (F[id] != null && el.tagName !== 'SELECT') {
      el.value = F[id]
    }
  }
  const words = q =>
    String(q || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  const hasAll = (text, q) => words(q).every(w => text.toLowerCase().includes(w))
  const applMatch = (s) => {
    if (F.aroom === '__none'
      ? s.room
      : F.aroom && s.room !== F.aroom) {
      return false
    }
    const show = F.ashow || ''
    if (show === 'running' && !s.running) {
      return false
    }
    if (show === 'measured' && !s.metered) {
      return false
    }
    if (show === 'steps' && s.metered) {
      return false
    }
    if ((show === 'look' || show === 'relink') && !(s.relink || s.varHint || s.sure?.level === 'unsure')) {
      return false
    }
    if (show === 'problem' && s.devOk !== false) {
      return false
    }
    if (show === 'tiles' && !(s.exposed || s.statusType !== 'none')) {
      return false
    }
    if (show === 'notiles' && (s.exposed || s.statusType !== 'none')) {
      return false
    }
    return hasAll(`${s.name} ${s.room} ${s.devName || ''}`, F.aq)
  }
  function renderApplFilters() {
    const rooms = [
      ...new Set(V.sigs.map(s => s.room).filter(Boolean)),
    ].sort(roomSort)
    put(
      '#aroom',
      `<option value="">All rooms</option>${rooms.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}${V.sigs.some(s => !s.room)
        ? '<option value="__none">No room</option>'
        : ''}`,
    )
    if (F.aroom && ![
      ...$('#aroom').options,
    ].some(o => o.value === F.aroom)) {
      F.aroom = ''
    }
    $('#aroom').value = F.aroom || ''
    $('#ashow').value = F.ashow || ''
  }
  // "Other": what the appliances don't explain, so the outlets add up to the whole house; its outlet is set here (Edit)
  function otherRow(top) {
    const S = V.settings
    const oName = (otherDraft?.name ?? S.other.name) || 'Other appliances'
    const oOn = otherDraft?.on ?? S.other.on
    const oW = V.now?.other || 0
    return F.aq || F.aroom || F.ashow
      ? ''
      : `<div class="agrp"><div class="agrp-h"><span>Everything else</span></div><div class="arow other${oW > 5
        ? ' on'
        : ''}">
        <div class="aname">${ico('help')}<div style="min-width:0"><div class="n">${esc(S.other.name)}</div><div class="muted via">what your appliances don't explain${S.other.on ? ' · an outlet in Apple Home' : ''}</div></div></div>
        <div class="anow">${oW > 5
    ? `<span class="pill on">${W(oW)}</span>`
    : '–'}</div>
        <div class="atoday" title="Today">${kWh(V.otherToday || 0)}<div class="ubar"><div style="width:${Math.min(100, Math.round(((V.otherToday || 0) / top) * 100))}%"></div></div></div>
        <div class="aact"><button class="btn btn-link btn-sm" data-edit="__other__">Edit</button></div></div>
      ${
  editing === '__other__'
    ? `<div class="edit" data-otherform>
        <label class="pchk"><input type="checkbox" id="tOther"${oOn ? ' checked' : ''}> <span><b>An outlet in Apple Home</b> <span class="muted">· so the outlets add up to the whole house</span></span></label>
        <div class="pr"><label class="l" for="tOtherName">Its name</label><div class="pc"><input class="form-control" id="tOtherName" value="${esc(oName)}" maxlength="32" style="max-width:16rem"></div></div>
        <div class="gap" style="margin-top:.6rem"><button class="btn btn-primary btn-sm" id="saveTiles">Save</button><button class="btn btn-secondary btn-sm" data-edit="__other__">Cancel</button>${S.other.on && V.tiles.matterOn
    ? `<button class="btn btn-outline-secondary btn-sm" data-mrefresh="__other__" data-mname="${esc(S.other.name)}" title="If Apple Home doesn't show its watts">Refresh in Apple Home</button>`
    : ''}</div>
        ${more('If Apple Home doesn\'t show an outlet\'s watts (iPhone and home hub on version 27 or later), <b>Refresh in Apple Home</b> publishes it again as a new outlet so Apple Home reads it afresh; its room, name and automations then need setting up again. Outlets come over Matter; running tiles, alert tiles and Cheap Power Now over HomeKit, so this plugin\'s bridge needs both on. Each appliance\'s own outlet and tiles are set in its Edit panel.')}</div>`
    : ''
  }</div>`
  }
  function renderAppl() {
    renderApplFilters()
    const all = V.sigs
    const L = all.filter(s => applMatch(s) || s.id === editing)
    const filtered = L.length !== all.length
    const nRun = all.filter(x => x.running).length
    put('#applNote', all.length
      ? `· ${plural(all.length, 'appliance')}${nRun
        ? `, ${nRun} running`
        : ''}`
      : '')
    put('#acount', all.length
      ? (filtered
          ? `${L.length} of ${all.length}`
          : plural(all.length, 'appliance'))
      : '')
    $('#applFilters').style.display = all.length > 5 || F.aq || F.aroom || F.ashow
      ? ''
      : 'none' // never a hidden filter still applying
    if (all.length && !L.length) {
      return put(
        '#appl',
        '<p class="muted">No appliance matches. <span class="linky" data-clearf="a">Show all</span></p>',
      )
    }
    if (!L.length) {
      return put(
        '#appl',
        `<p class="muted">None yet. Name a repeating step or track a device when they show up in "Found" above, add your Shellys and Matter devices with <span class="linky" data-adddev>+ Add a device</span>, or import a backup under Settings → Data.</p>${
          otherRow(Math.max(0.001, V.otherToday || 0))}`,
      )
    }
    const rooms = new Map()
    const RO = [...V.settings.rooms].sort(roomSort)
    for (const s of L) {
      const r = s.room || ''
      if (!rooms.has(r)) {
        rooms.set(r, [])
      }
      rooms.get(r).push(s)
    }
    if (roomsEditing) {
      for (const r of RO) {
        if (!rooms.has(r)) {
          rooms.set(r, [])
        }
      }
    } // editing rooms: empty ones too
    const order = [
      ...rooms.keys(),
    ].sort(roomSort)
    // Edit rooms: each room's heading gets ↑ ↓ (the order of this list and the room pickers), Rename and ✕
    const roomCtl = (r) => {
      const i = RO.indexOf(r)
      if (!r || i < 0) {
        return ''
      }
      return `<span class="ra"><button class="btn btn-link btn-sm" data-roomup="${i}" title="Move up"${i ? '' : ' disabled'}>↑</button><button class="btn btn-link btn-sm" data-roomdown="${i}" title="Move down"${i < RO.length - 1
        ? ''
        : ' disabled'}>↓</button><button class="btn btn-link btn-sm" data-roomren="${esc(r)}">Rename</button><button class="btn btn-link btn-sm" data-roomrm="${esc(r)}" title="Remove this room">✕</button></span>`
    }
    const bar = `<div class="roomsbar${roomsEditing ? ' on' : ''}">${roomsEditing ? '<span class="muted">Move, rename or remove a room on its heading. The order here is the order of the room pickers too.</span>' : ''}<button class="btn btn-link btn-sm" data-roomsedit>${roomsEditing ? 'Done' : 'Edit rooms'}</button></div>`
    const addRoom = roomsEditing
      ? '<div class="gap" style="margin-top:.6rem"><input class="form-control" id="roomNew" maxlength="40" placeholder="New room, e.g. Laundry" style="max-width:16rem"><button class="btn btn-outline-primary btn-sm" id="roomAdd">Add room</button></div>'
      : ''
    // one card per appliance, grouped by room: icon and name (and what measures it), watts now, today's energy with a bar
    // against the busiest appliance today, and Edit
    const top = Math.max(0.001, ...L.map(x => x.today || 0))
    const body = order
      .map((r) => {
        const list = rooms
          .get(r)
          .sort((a, b) => b.running - a.running || b.today - a.today || a.name.localeCompare(b.name))
        const on = list.filter(s => s.running).length
        return (
          `<div class="agrp"><div class="agrp-h${roomsEditing && r
            ? ' edit'
            : ''}"><span>${esc(r || 'No room')} <span class="muted">· ${list.length || 'empty'}${on
            ? `, ${on} running`
            : ''}</span></span>${roomsEditing
            ? roomCtl(r)
            : ''}</div>${
            list
              .map(
                s => `<div class="arow${s.running ? ' on' : ''}">
        <div class="aname">${ico(s.icon)}<div style="min-width:0"><div class="n">${esc(s.name)}${needsLook(s)}</div>${s.devId
            ? `<div class="muted via">via ${esc(s.devName || 'its device')}${s.estimated ? ', switched' : ''}${s.devOk === false
              ? ' · <span class="err">not connected</span>'
              : ''}</div>`
            : ''}</div></div>
        <div class="anow">${s.running
            ? `<span class="pill on">${s.nowW
              ? W(s.nowW)
              : 'running'}</span>${s.cycle || s.remaining != null
              ? `<div class="muted">${s.cycle
                ? esc(cycleName(s.cycle))
                : ''}${s.cycle && s.remaining != null
                ? ' · '
                : ''}${s.remaining != null
                ? `${dur(s.remaining)} left`
                : ''}</div>`
              : ''}`
            : `<span class="muted">${s.lastSeen
              ? ago(s.lastSeen)
              : '–'}</span>`}</div>
        <div class="atoday" title="Today">${kWh(s.today)}<div class="ubar"><div style="width:${Math.round(((s.today || 0) / top) * 100)}%"></div></div></div>
        <div class="aact"><button class="btn btn-link btn-sm" data-edit="${s.id}">Edit</button></div></div>
        ${editing === s.id
            ? editForm(s)
            : ''}`,
              )
              .join('')
          }</div>`
        )
      })
      .join('')
    put('#appl', bar + body + otherRow(top) + addRoom)
  }
  const SURE = { exact: 'Exact', good: 'Confident', unsure: 'Not sure yet' }
  // an appliance's Edit panel, in three groups: Basics, Apple Home, and (folded, remembered) How it's recognised
  const RECOG_KEY = 'home-energy-recog'
  const recogOpen = () => {
    try {
      return localStorage.getItem(RECOG_KEY) === '1'
    } catch {
      return false
    }
  }
  function editForm(s) {
    const steady = s.steadyOutlet === true
      ? 'always'
      : s.steadyOutlet === 'idle'
        ? 'idle'
        : 'off'
    const how = s.estimated
      ? `Switched by ${esc(s.devName || 'its device')}, using ${s.estW
        ? `the ${W(s.estW)} you typed`
        : `about ${W(s.estNow)} learned from the meter`}.`
      : s.metered
        ? `Measured by ${esc(s.devName || 'its device (not connected)')}.`
        : `Recognised from whole-house steps of about ${W(s.watts)}${s.stages
          ? ` (+ ${plural(s.stages, 'extra stage')})`
          : ''}.`
    const free = V.devices
      .filter(d => !d.sensor && !d.tracked && (typeof d.watts === 'number' || typeof d.on === 'boolean'))
      .sort((a, b) => a.name.localeCompare(b.name))
    const devOpt = d =>
      `<option value="${esc(d.id)}">${esc(d.name)}${typeof d.watts === 'number'
        ? ` (measures its watts, now ${W(d.watts)})`
        : d.est?.w
          ? ` (switches, about ${W(d.est.w)} learned)`
          : ' (switches, no watts learned yet)'}</option>`
    const check = (f, on, text) =>
      `<label style="display:flex;gap:.4rem;align-items:flex-start;font-weight:400"><input type="checkbox" data-f="${f}"${on ? ' checked' : ''} style="margin-top:.25rem"> ${text}</label>`
    const link = s.devId
      ? ''
      : `<div><label class="l">Measure it with a device</label><div class="gap">
        <select class="form-control" data-link="${s.id}" style="flex:1;min-width:12rem"><option value="">Choose a device…</option>${free.map(devOpt).join('')}</select>
        <button class="btn btn-outline-primary btn-sm" data-dolink="${s.id}">Link</button></div>
        <div class="help">${free.length ? 'Its history stays; its figures then come from the device.' : 'No free devices yet: use + Add a device first.'}</div></div>`
    // an appliance with a device: its devices (several combined count as one), and adding another
    const combo = s.devId
      ? `<div><label class="l">Its devices${s.devs.length > 1
        ? ' (combined)'
        : ''}</label>
        ${s.devs.length > 1
    ? `<div>${s.devs.map(x => `<span class="chip">${esc(x.name)}${x.ok ? '' : ' <span class="err">not connected</span>'} <button class="btn btn-link btn-sm" data-separate="${esc(x.id)}" data-sig="${s.id}" title="Take this device out">✕</button></span>`).join(' ')}</div>`
    : `<div>${esc(s.devs[0]?.name || '')}</div>`}
        ${
  free.length
    ? `<div class="gap" style="margin-top:.4rem"><select class="form-control" data-combinesel="${s.id}" style="flex:1;min-width:12rem"><option value="">Add another device to it…</option>${free.map(devOpt).join('')}</select>
          <button class="btn btn-outline-primary btn-sm" data-combine="${s.id}">Add</button></div>`
    : ''
  }
        ${more('Combine devices that make one thing, like two lamps as "Study lights": their watts are added up, it\'s on while any of them is, and it\'s one outlet in Apple Home. What it learned about its runs starts again when its devices change.')}</div>`
      : ''
    const relink = s.relink
      ? `<div class="note" style="margin-top:0">This was measured through another Homebridge plugin, which this plugin can't read. If it's a Shelly or Matter device, add it with + Add a device and link it below. <button class="btn btn-link btn-sm" data-keep="${s.id}">Keep it on steps</button></div>`
      : ''
    const learned
      = s.metered && !s.estimated
        ? `${s.learnCycles
          ? `Learned from ${plural(s.learnCycles, 'run')}`
          : 'Nothing learned yet'}${s.standbyLearned != null
          ? `, including a standby of about ${W(s.standbyLearned)}`
          : ''}. Empty boxes use what it learned.`
        : ''
    const recog = [
      link,
      combo,
      s.metered
        ? ''
        : `<div><label class="l">Its power</label>${check('variable', s.variable, 'Varies while it runs')}
        <div class="help">${s.varHint ? '<b>Looks like it:</b> its runs often end without a matching step.' : 'A heat pump, an air conditioner, an EV charger.'}</div>
        ${more('Whatever the house draws above what it drew when this started counts as this, and it\'s finished when that falls to next to nothing.')}</div>`,
      s.metered && !s.estimated
        ? `<div><label class="l">Running above (W) <span class="muted">· ${SRC[s.runSrc]}</span></label><input class="form-control" type="number" min="0.5" step="0.5" data-f="runW" value="${s.runSrc === 'set'
          ? s.runW
          : ''}" placeholder="${s.runW} (${SRC[s.runSrc]})"></div>
        <div><label class="l">Finished after this long below (min) <span class="muted">· ${SRC[s.finishSrc]}</span></label><input class="form-control" type="number" min="0" max="240" step="0.5" data-f="finishMin" value="${s.finishSrc === 'set'
    ? s.finishMin
    : ''}" placeholder="${s.finishMin} (${SRC[s.finishSrc]})"></div>`
        : '',
      s.estimated
        ? `<div><label class="l">Watts (empty = learned, about ${W(s.estNow)})</label><input class="form-control" type="number" min="0.1" step="0.1" data-f="estW" value="${s.estW ?? ''}"></div>`
        : '',
    ]
      .filter(Boolean)
      .join('')
    const cycles
      = s.metered && !s.estimated
        ? `<div style="margin-top:.6rem"><label class="l">Cycles learned</label>
      ${
  s.cycles.length
    ? `<div class="scroll"><table><tbody>${s.cycles
      .map(
        c => `<tr><td>${esc(c.name)}</td><td class="num">about ${dur(c.dur)}</td><td class="num">${kWh(c.kwh)}</td><td class="muted">${plural(c.n, 'run')}</td>
        <td class="actions"><button class="btn btn-link btn-sm" data-cyname="${esc(c.id)}" data-sig="${s.id}" data-cur="${esc(c.name)}">Rename</button><button class="btn btn-link btn-sm" data-cyforget="${esc(c.id)}" data-sig="${s.id}" title="Forget this cycle">✕</button></td></tr>`,
      )
      .join('')}</tbody></table></div>`
    : '<div class="help">None yet: each full run teaches it.</div>'
  }
      ${more(`${s.cycles.length ? 'Name them after the programmes they are (Eco, Quick…). ' : ''}Each full run is matched by its power pattern and length; runs that look alike are one cycle. While it runs, the time left comes from the cycle it looks like so far ("probably…" until it's sure), here and on the Faucet running tile in Apple Home.`)}</div>`
        : ''
    const openRecog = recogOpen() || !!s.relink || !!s.varHint
    return `<div class="edit" data-form="${s.id}">${relink}<p class="help" style="margin:0 0 .3rem">${how}${s.sure
      ? ` <b>${SURE[s.sure.level]}:</b> ${esc(s.sure.why)}`
      : ''}${s.runs
      ? ` ${plural(s.runs, 'run')} so far, ${kWh(s.kwh)} in all.`
      : ''}${s.standbyW != null
      ? ` Uses about ${W(s.standbyW)} while idle.`
      : ''}</p>
      <div class="grp-h">Basics</div><div class="row2">
      <div><label class="l">Name</label><input class="form-control" data-f="name" value="${esc(s.name)}" maxlength="60"></div>
      <div><label class="l">Icon</label>${iconSelect(`ic-${s.id}`, s.icon)}</div>
      <div><label class="l">Room</label>${roomPicker(`ed-${s.id}`, s.room)}</div></div>
      <div class="grp-h">Apple Home</div><div class="row2">
      <div><label class="l">Matter outlet</label><select class="form-control" data-f="exposed"><option value="1"${s.exposed ? ' selected' : ''}>Yes, with watts and energy</option><option value="0"${s.exposed ? '' : ' selected'}>No</option></select></div>
      <div><label class="l">Outlet shows On</label><select class="form-control" data-f="steady"><option value="off"${steady === 'off'
    ? ' selected'
    : ''}>While it's running</option><option value="idle"${steady === 'idle'
    ? ' selected'
    : ''}>Through short pauses</option><option value="always"${steady === 'always'
    ? ' selected'
    : ''}>Always (fridge, freezer)</option></select></div>
      <div><label class="l">Pauses up to (minutes)</label><input class="form-control" type="number" min="1" max="180" data-f="idle" value="${s.steadyIdleMin}"></div>
      <div><label class="l">Running tile (HomeKit)</label><select class="form-control" data-f="status">${Object.entries(
    TILE,
  )
    .map(([k, l]) => `<option value="${k}"${k === s.statusType
      ? ' selected'
      : ''}>${l}</option>`)
    .join('')}</select>
        <div class="help">Shows when it runs; tapping it does nothing.</div>${more('Humidifier tiles also show a humidity, and heater and air conditioner tiles a temperature: from a sensor this plugin reads (a Matter hub\'s, say), otherwise 50% or 20°C.')}</div>
      <div><label class="l">Copies of the running tile</label><input class="form-control" type="number" min="1" max="10" data-f="count" value="${s.statusCount}"><div class="help">One for each room you want it in.</div></div>
      <div><label class="l">Alert</label>${check('alertLong', s.alertLong, 'When it runs far longer than usual')}
        ${more(`A sensor tile, "${esc(s.name)} running long", turns on when a run reaches twice its usual length (and 30 minutes over), so the Home app can notify you: a fridge left open, a heater that won't stop. Needs HomeKit on for this plugin's bridge.`)}</div></div>
      <details class="recog" style="margin-top:.6rem"${openRecog ? ' open' : ''}><summary class="grp-h" style="cursor:pointer;display:block">How it's recognised ${openRecog ? '' : '<span style="text-transform:none;letter-spacing:0;font-weight:400">· more</span>'}</summary>
        ${learned
    ? `<p class="help" style="margin:0 0 .4rem">${learned}</p>`
    : ''}<div class="row2">${recog}</div>${cycles}</details>
    <div class="gap" style="margin-top:.8rem"><button class="btn btn-primary btn-sm" data-save="${s.id}">Save</button><button class="btn btn-secondary btn-sm" data-cancel>Cancel</button>
      ${s.devId
    ? `<button class="btn btn-outline-secondary btn-sm" data-untrack="${s.id}">Stop tracking its device</button>`
    : ''}
      ${s.exposed && V.tiles.matterOn
    ? `<button class="btn btn-outline-secondary btn-sm" data-mrefresh="${s.id}" data-mname="${esc(s.name)}" title="If Apple Home doesn't show its watts">Refresh in Apple Home</button>`
    : ''}
      ${s.metered && !s.estimated && (s.learnCycles || s.runSrc === 'learned' || s.finishSrc === 'learned')
    ? `<button class="btn btn-outline-secondary btn-sm" data-forgetlearn="${s.id}">Forget what was learned</button>`
    : ''}
      <button class="btn btn-outline-danger btn-sm" data-forget="${s.id}" style="margin-left:auto">Forget</button></div></div>`
  }

  // ----- Settings → Shellys and Matter devices: the hardware, one row each, with what it reads -----
  const MSTAT = {
    connected: ['ok', 'Connected'],
    connecting: ['wait', 'Connecting…'],
    reconnecting: ['wait', 'Reconnecting…'],
    pairing: ['wait', 'Pairing… (up to 3 minutes)'],
    offline: ['', 'Offline'],
    failed: ['', 'Failed'],
  }
  const readsOf = parts =>
    parts.length
      ? parts
          .map((d) => {
            const t = V.sigs.find(x => x.id === d.tracked)
            return `${esc(d.name)}${t
              ? ` <span class="muted">→ ${esc(t.name)}</span>`
              : d.hidden ? ' <span class="muted">(hidden)</span>' : ' <span class="muted">(not set up)</span>'}`
          })
          .join(' · ')
      : '<span class="muted">nothing to read yet</span>'
  function renderDev() {
    const sys = V.matterSystem
    put('#matterSys', sys.ok
      ? ''
      : `<div class="note">Matter devices can't be read: ${esc(sys.error)}</div>`)
    const groups = []
    for (const s of V.shelly) {
      const parts = V.devices.filter(d => d.protocol === 'shelly' && d.host === s.host && !d.sensor)
      groups.push({
        head: `${esc(s.name || s.model || s.host)} <span class="muted">· Shelly${s.kind
          ? `, ${{ homekit: 'HomeKit firmware', rpc: 'Gen2+', gen1: 'Gen1' }[s.kind] || s.kind}`
          : ''} · ${esc(s.host)}</span>`,
        status: `<span class="dot ${s.ok
          ? 'ok'
          : s.ok == null
            ? 'wait'
            : ''}"></span>${s.ok && s.live
          ? '<span title="Changes arrive the moment they happen">Connected, live</span>'
          : esc(s.ok ? 'Connected' : s.msg)}${!s.ok && s.seen
          ? ` <span class="muted">(last seen ${ago(s.seen)})</span>`
          : ''}`,
        actions: `<button class="btn btn-link btn-sm" data-shrm="${esc(s.host)}" title="Remove this address">✕</button>`,
        parts,
        sort: (s.name || s.host).toLowerCase(),
        kind: 'shelly',
        problem: s.ok === false,
        text: `${s.name} ${s.model} ${s.host} ${parts.map(d => d.name).join(' ')}`,
      })
    }
    for (const m of V.matter) {
      const [c, l] = MSTAT[m.status] || ['', m.status]
      const all = V.devices.filter(d => d.source === m.id)
      const parts = all.filter(d => !d.sensor)
      const sens = all.length - parts.length
      groups.push({
        head: `${esc(m.name)} <span class="muted">· Matter${m.product
          ? `, ${esc(m.product)}`
          : ''}${sens
          ? ` · ${plural(sens, 'sensor')} (not used)`
          : ''}</span>`,
        status: `<span class="dot ${c}"></span>${esc(l)}${m.error
          ? `<div class="err">${esc(m.error)}</div>`
          : ''}`,
        actions: `${['failed', 'offline'].includes(m.status)
          ? `<button class="btn btn-link btn-sm" data-mretry="${m.id}">Try again</button>`
          : ''}<button class="btn btn-link btn-sm" data-mremove="${m.id}" title="Remove">✕</button>`,
        parts,
        sort: m.name.toLowerCase(),
        kind: 'matter',
        problem: ['failed', 'offline'].includes(m.status),
        text: `${m.name} ${m.product} ${parts.map(d => d.name).join(' ')}`,
      })
    }
    const total = groups.length
    const na = groups.filter(g => g.problem).length
    put('#hwNote', `· ${plural(total, 'device')}${na
      ? `, ${na} not connected`
      : ''}, hidden`)
    // in Appliances too, so a problem is seen where the appliances are, with a way to the list
    put(
      '#devProblems',
      na
        ? `<span class="err">${plural(na, 'device')} not connected</span> <span class="linky" data-devproblems>Show</span>`
        : '',
    )
    if (!addDev.auto && !total) {
      addDev.auto = true
      addDev(true)
    } // nothing added yet: the forms are open to start with
    put(
      '#sum-set',
      na
        ? `${plural(na, 'device')} not connected`
        : !V.settings.em.host
            ? 'meter not set up'
            : !V.em.ok && V.em.msg !== 'Connecting…'
                ? 'meter not connected'
                : '',
    )
    $('#sum-set').classList.toggle('bad', !!$('#sum-set').textContent)
    $('#devFilters').style.display = total > 3 || F.dq || F.dshow
      ? ''
      : 'none'
    if (!total) {
      put('#dcount', '')
      return put('#dev', '<p class="muted">None yet.</p>')
    }
    const show = F.dshow || ''
    const shown = groups
      .filter(
        g =>
          !(show === 'problem' && !g.problem)
          && !(show === 'shelly' && g.kind !== 'shelly')
          && !(show === 'matter' && g.kind !== 'matter')
          && (!F.dq || hasAll(g.text, F.dq)),
      )
      .sort((a, b) => b.problem - a.problem || a.sort.localeCompare(b.sort))
    put('#dcount', shown.length !== total
      ? `${shown.length} of ${total}`
      : plural(total, 'device'))
    if (!shown.length) {
      return put('#dev', '<p class="muted">No device matches. <span class="linky" data-clearf="d">Show all</span></p>')
    }
    put(
      '#dev',
      `<div class="scroll"><table><thead><tr><th>Device</th><th>Status</th><th></th></tr></thead><tbody>
      ${shown.map(g => `<tr><td>${g.head}<div style="font-size:.85em;margin-top:.15rem">${readsOf(g.parts)}</div></td><td>${g.status}</td><td class="actions">${g.actions}</td></tr>`).join('')}</tbody></table></div>`,
    )
  }

  // ----- Settings: meter, devices, plan (with its Apple Home tiles), web page, Data -----
  function renderSettings() {
    renderMeter()
    renderDev()
    renderPlan()
    renderWeb()
    renderHealth()
    renderData()
  }
  // Edit rooms (Your appliances): move up and down, rename, remove, add
  function renderMeter() {
    const em = V.settings.em
    const chs = V.em.channels || []
    if (!$('#card-meter')._init) {
      $('#emHost').value = em.host
      $('#threshold').value = V.settings.threshold
      $('#card-meter')._init = true
      if (!em.host) {
        $('#sec-set').open = true
      }
    }
    const opts = [
      ['auto', 'First meter found'],
      ...chs.map(c => [c.key, `${c.label} (now ${W(c.p)})`]),
      ['sum', 'All clamps added together'],
    ]
    if (!opts.some(o => o[0] === em.channel)) {
      opts.push([em.channel, em.channel])
    }
    put(
      '#emChannel',
      opts
        .map(([k, l]) => `<option value="${esc(k)}"${k === em.channel
          ? ' selected'
          : ''}>${esc(l)}</option>`)
        .join(''),
    )
  }
  const hours = v =>
    Array.from(
      { length: 25 },
      (_, h) => `<option value="${h}"${h === v
        ? ' selected'
        : ''}>${String(h).padStart(2, '0')}:00</option>`,
    ).join('')
  // the plan: a flat rate, or day and night rates with the night's hours chosen (the day rate is every other hour), plus any
  // extra periods (weekends, a peak). Stored as tariff.rate = the day (or flat) rate, tariff.periods[0] = the night.
  const hourText = h => `${String(h % 24).padStart(2, '0')}:00`
  function renderPlan(force = false) {
    const T = planDraft || V.settings.tariff
    const cur = V.settings.currency
    const tou = T.mode === 'tou' && T.periods.length
    const night = T.periods[0] || {
      name: 'Night',
      from: 21,
      to: 7,
      days: 'all',
      rate: 0,
    }
    const extra = T.periods.slice(1)
    const days = p =>
      [
        ['all', 'Every day'],
        ['weekdays', 'Weekdays'],
        ['weekends', 'Weekends'],
      ]
        .map(([k, l]) => `<option value="${k}"${p.days === k
          ? ' selected'
          : ''}>${l}</option>`)
        .join('')
    const moneyBox = (id, v, step = '0.0001') =>
      `<div class="money"><span>${esc(cur)}</span><input class="form-control" id="${id}" type="number" min="0" step="${step}" value="${v || ''}"></div>`
    // grouped: Rates, Charges, Your bill, Apple Home tiles; one line per thing, narrow boxes, the long explanations under More
    const row = (label, body, forId) =>
      `<div class="pr"><label class="l"${forId
        ? ` for="${forId}"`
        : ''}>${label}</label><div class="pc">${body}</div></div>`
    const dayHours
      = night.from === night.to
        ? 'Night covers no hours: set its hours.'
        : `${hourText(night.to)}–${hourText(night.from)}, every hour that isn't night`
    const tz = 'style="font-weight:400;margin:0"'
    put(
      '#plan',
      `<div class="psec"><div class="ph">Rates</div>
      ${row('Plan', `<select class="form-control" id="pMode"><option value="single"${T.mode !== 'tou'
    ? ' selected'
    : ''}>One rate all day</option><option value="tou"${T.mode === 'tou'
    ? ' selected'
    : ''}>Day and night rates</option></select>`, 'pMode')}
      ${
  T.mode === 'tou'
    ? `${row('Day rate', `${moneyBox('pRate', T.rate)}<span class="muted">per kWh</span><span class="help" id="pDayHours">${dayHours}</span>`, 'pRate')}
      ${row('Night rate', `${moneyBox('pNight', night.rate)}<span class="muted">per kWh, from</span><select class="form-control" id="pNFrom" title="Night from">${hours(night.from)}</select><span class="muted">until</span><select class="form-control" id="pNTo" title="Night until">${hours(night.to)}</select>`, 'pNight')}
      ${
  extra.length
    ? `<div class="pr"><span class="l">Other rates</span><div class="pc" style="display:block"><div class="scroll"><table><thead><tr><th>Name</th><th>From</th><th>Until</th><th>Days</th><th>Rate</th><th></th></tr></thead><tbody>${extra
      .map(
        (p, k) => `<tr data-per="${k + 1}">
      <td><input class="form-control form-control-sm" data-p="name" value="${esc(p.name)}" maxlength="30"></td>
      <td><select class="form-control form-control-sm" data-p="from">${hours(p.from)}</select></td><td><select class="form-control form-control-sm" data-p="to">${hours(p.to)}</select></td>
      <td><select class="form-control form-control-sm" data-p="days">${days(p)}</select></td>
      <td><input class="form-control form-control-sm" type="number" min="0" step="0.0001" data-p="rate" value="${p.rate}"></td><td><button class="btn btn-link btn-sm" data-delper="${k + 1}" title="Remove this rate">✕</button></td></tr>`,
      )
      .join('')}</tbody></table></div><div class="help">These come first in their hours.</div></div></div>`
    : ''
  }
      <div class="pr"><span></span><div class="pc"><button class="btn btn-link btn-sm" id="addPer" style="padding-left:0"${T.periods.length >= 8
    ? ' disabled'
    : ''}>+ Add another rate (weekends, a peak…)</button></div></div>`
    : row('Rate', `${moneyBox('pRate', T.rate)}<span class="muted">per kWh</span>`, 'pRate')
  }
    </div>
    <div class="psec"><div class="ph">Charges</div>
      ${row('Daily fixed charge', `${moneyBox('pFixed', T.fixed, '0.01')}<span class="muted">a day, whatever you use</span>`, 'pFixed')}
      ${row('Tax', `<input class="form-control pnum" id="pTax" type="number" min="0" max="50" step="0.1" value="${T.tax || ''}"><span class="muted">%</span><label ${tz}><input type="checkbox" id="pTaxIncl"${T.taxIncl !== false
    ? ' checked'
    : ''}> prices already include it</label>`, 'pTax')}
      ${row('Currency symbol', `<input class="form-control pcur" id="pCur" maxlength="4" value="${esc(cur)}">`, 'pCur')}
    </div>
    <div class="psec"><div class="ph">Your bill</div>
      ${row(
    'Starts on day',
    `<select class="form-control" id="pBillDay">${Array.from({ length: 28 }, (_, i) => i + 1)
      .map(
        n =>
          `<option value="${n}"${n === (V.settings.billDay || 1)
            ? ' selected'
            : ''}>${n === 1
            ? '1 (calendar month)'
            : n}</option>`,
      )
      .join('')}</select>`,
    'pBillDay',
  )}
      ${row('Budget', `<div class="money pmoney"><span>${esc(cur)}</span><input class="form-control" id="pBudget" type="number" min="0" step="1" value="${V.settings.budget || ''}" placeholder="none"></div><span class="muted">per bill</span>`, 'pBudget')}
      ${more('The bill day is the day of the month your bill starts on, as on your bill. Today\'s bill total, its forecast and the budget follow it. Leave the budget empty for none.')}
    </div>
    <div class="psec"><div class="ph">Apple Home tiles</div>
      ${tou
    ? `<label class="pchk"><input type="checkbox" id="pCheap"${V.settings.cheapTile ? ' checked' : ''}> <span><b>Cheap Power Now</b> <span class="muted">· on during this plan's cheapest hours, for automations</span></span></label>`
    : ''}
      <label class="pchk"><input type="checkbox" id="pBudgetTile"${V.settings.budgetTile ? ' checked' : ''}> <span><b>Over Budget</b> <span class="muted">· on while this bill is heading over its budget</span></span></label>
    </div>
    <div class="gap" style="margin-top:.8rem"><button class="btn btn-primary btn-sm" id="savePlan">Save</button><span class="unsaved-note">Not saved yet</span></div>`,
      force,
    )
  }
  function readPlan() {
    const T = {
      ...(planDraft || V.settings.tariff),
    }
    const was = T.periods || []
    T.mode = $('#pMode').value
    T.rate = +$('#pRate').value || 0
    T.fixed = +$('#pFixed').value || 0
    T.tax = +$('#pTax').value || 0
    T.taxIncl = $('#pTaxIncl').checked
    if ($('#pNight')) {
      const night = {
        ...(was[0] || { name: 'Night', days: 'all' }),
        rate: +$('#pNight').value || 0,
        from: +$('#pNFrom').value,
        to: +$('#pNTo').value,
      }
      T.periods = [
        night,
        ...$$('#plan tr[data-per]').map((tr) => {
          const g = k => tr.querySelector(`[data-p="${k}"]`).value
          return {
            name: g('name'),
            from: +g('from'),
            to: +g('to'),
            days: g('days'),
            rate: +g('rate') || 0,
          }
        }),
      ]
    } else {
      T.periods = was
    }
    return T
  }
  // the plugin's own web page: switched on and given a PIN here, in the Homebridge UI only
  function renderWeb() {
    const w = V.web
    if (HB.web) {
      return put(
        '#webcard',
        '<p class="help" style="margin:0">You\'re on the web page now. Its PIN, and switching it off, are on the plugin\'s settings page in the Homebridge UI.</p>',
      )
    }
    const prow = (l, v) => `<div class="pr"><span class="l">${l}</span><div class="pc">${v}</div></div>`
    if (!w.port) {
      return put(
        '#webcard',
        sec(
          'Access',
          'The same page in a full browser window, for your home network only, behind a PIN.',
          '',
          '<p class="muted">Switched off in config.json ("webPort": 0).</p>',
        ),
      )
    }
    put(
      '#webcard',
      sec(
        'Access',
        'The same page in a full browser window, for phones and computers on your home network only.',
        'The web page is plain HTTP, like most home devices: anyone who can watch your Wi-Fi traffic could see the PIN as it\'s typed. Use it only on a network you trust, and keep it view-only if others use your Wi-Fi.',
        `<label class="pchk"><input type="checkbox" id="webOn"${w.on ? ' checked' : ''}> <span><b>Web page on</b></span></label>
      <label class="pchk"><input type="checkbox" id="webRO"${w.readOnly ? ' checked' : ''}> <span><b>View only</b> <span class="muted">· shows everything, changes nothing: for phones and the rest of the family</span></span></label>
      ${
  !w.on
    ? ''
    : w.running
      ? prow(
          'Open',
          w.urls.length
            ? w.urls.map(u => `<b>${esc(u)}</b>`).join(' or ')
            : `http://&lt;this computer's address&gt;:${w.port}/`,
        )
      : prow(
          'Open',
          w.pinSet
            ? '<span class="muted">starting…</span>'
            : '<span class="err">opens once you set a PIN below</span>',
        )
  }`,
      )
      + sec(
        'PIN',
        'Needed to sign in. Changing it signs every browser out.',
        'A browser stays signed in for 30 days. Five wrong PINs make that device wait 10 minutes, and many wrong PINs across the network pause signing in for everyone for a while. At least 6 characters; easy ones like 123456 aren\'t allowed.',
        `<div class="pr"><label class="l" for="webPin">${w.pinSet ? 'New PIN' : 'PIN'}</label><div class="pc"><input class="form-control pwide" id="webPin" type="password" autocomplete="new-password" placeholder="6 or more characters"><button class="btn btn-primary btn-sm" id="saveWebPin">${w.pinSet ? 'Change PIN' : 'Set PIN'}</button>
        ${w.sessions
    ? `<button class="btn btn-outline-secondary btn-sm" id="webSignOut">Sign out ${plural(w.sessions, 'browser')}</button>`
    : ''}</div></div>`,
      ),
    )
  }
  // how the saved data is doing: last saved, file sizes, today's missing readings, and the check against the meter's count
  function renderHealth() {
    const H = V.health
    if (!H) {
      return put('#health', '')
    }
    const kb = b => (b >= 1048576
      ? `${(b / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`)
    const prow = (l, v) => `<div class="pr"><span class="l">${l}</span><div class="pc">${v}</div></div>`
    const rows = [
      prow(
        'Last saved',
        H.savedAt
          ? `${ago(H.savedAt)}${H.bytes
            ? ` · ${kb(H.bytes)}, older days ${kb(H.histBytes)}`
            : ''}`
          : 'not yet',
      ),
      prow(
        'Today',
        esc(
          H.missMin
            ? `${H.missMin} min without readings${H.fillKwh > 0.005
              ? `, ${kWh(H.fillKwh)} filled in from the meter's own count`
              : H.counter ? '' : ' (this meter keeps no count to fill them in from)'}`
            : 'no readings missed',
        ),
      ),
    ]
    if (H.check) {
      rows.push(
        prow(
          `Last ${H.check.days} days`,
          esc(`${within(H.check)} the meter's own count (${kWh(H.check.ours)} vs ${kWh(H.check.meter)})`),
        ),
      )
    }
    const bad = H.recovered
      ? `<div class="note" style="border-left-color:var(--warn)">${H.recovered.fresh
        ? `The saved ${esc(H.recovered.what)} couldn't be read at start-up and there was no earlier copy, so it started fresh. Import a backup below to bring it back.`
        : `The saved ${esc(H.recovered.what)} couldn't be read at start-up, so the copy from up to a day earlier was used.`} The unreadable file was kept beside it.</div>`
      : ''
    put(
      '#health',
      sec(
        'Health',
        'How the saved data is doing.',
        'Readings are saved every few minutes, and within half a minute when you change something. Older days are kept in a second file that is only written when they change. A copy of each from up to a day earlier is kept too, and used if a file is ever damaged, say by a power cut. Gaps with no readings (a restart, Wi-Fi dropping out) are filled in from the meter\'s own running count where it keeps one, and put on Other.',
        rows.join('') + bad,
      ),
    )
  }
  function renderData() {
    const B = V.backups || []
    const imp = V.imported
    const nice = n =>
      n.replace(/^shelly-home-energy-|\.json$/g, '').replace(/^(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)(\d\d)$/, '$1 $2:$3:$4')
    const list = B.length
      ? `<div class="scroll" style="margin-top:.6rem"><table><thead><tr><th>Saved on the Homebridge computer</th><th class="num">Size</th><th></th></tr></thead><tbody>${B.map(f => `<tr><td>${esc(nice(f.name))}</td><td class="num">${Math.round(f.size / 1024)} KB</td><td class="actions"><button class="btn btn-link btn-sm" data-impbk="${esc(f.name)}">Import</button></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="help" style="margin-top:.5rem">No backups on the Homebridge computer yet.</p>'
    put(
      '#data',
      sec(
        'Backups',
        'Everything it has learned and recorded: download one, or bring one back.',
        'A backup has your appliances (with their Apple Home tiles), power steps, runs, daily and hourly energy, learned watts, Matter devices and energy settings, never the web page\'s PIN. Each one is saved on the Homebridge computer, where the newest 10 are kept and listed here, and downloaded to this device where the browser allows it (the Homebridge UI may not; the web page does). Importing brings those back; nothing else in the file is kept, and importing again replaces what came from the last import.',
        `<div class="gap"><button class="btn btn-outline-secondary btn-sm" id="export">Download a backup</button><label class="btn btn-outline-secondary btn-sm" style="margin:0">Import a backup file…<input type="file" id="impFile" accept=".json,application/json" hidden></label><span id="impMsg" class="muted"></span></div>
      ${list}${imp
    ? `<div class="note">Last import: ${esc(imp.from)}, ${new Date(imp.at).toLocaleString()}: ${imp.counts.appliances} appliances, ${imp.counts.steps} steps, ${imp.counts.days} days of energy, ${imp.counts.matter} Matter devices.</div>`
    : ''}`,
      ) + recCard(),
    )
  }

  // ---------- Find Shellys ----------
  const lc = v => String(v || '').toLowerCase()
  function foundState(f) {
    const hosts = V.settings.shellyHosts.map(lc)
    const as = hosts.find(h => h === lc(f.host) || h === lc(f.ip))
    const added = !!as || (!!f.idPrefix && V.devices.some(d => d.id.startsWith(f.idPrefix)))
    return {
      added,
      as,
      canName: !!as && as === lc(f.ip) && lc(f.host) !== lc(f.ip),
      meter: [
        lc(f.ip),
        lc(f.host),
      ].includes(lc(V.settings.em.host)),
    }
  }
  function renderFound() {
    if (finding) {
      return put('#found', '<p class="muted" style="margin:.5rem 0 0">Looking… this takes about 10 seconds.</p>')
    }
    if (!FOUND) {
      return put('#found', '')
    }
    const F = FOUND.found
    const nets = esc(FOUND.networks.join(', '))
    if (!F.length) {
      return put(
        '#found',
        `<div class="note" style="margin-top:.5rem">No Shellys answered at the ${FOUND.scanned} addresses on ${nets}. If your Shellys are on a separate network for smart devices, or switched off, add them by address below.</div>`,
      )
    }
    const rows = F.map((f) => {
      const st = foundState(f)
      const what = f.password
        ? '<span class="pill warn">password set</span> can\'t be read until device authentication is turned off in the Shelly app'
        : f.channels
          ? `${f.channels} channel${f.channels === 1
            ? ''
            : 's'}${f.measures ? ', measures watts' : ', on/off only'}${f.parts.length
            ? `<div class="muted" style="font-size:.85em">${f.parts.map(esc).join(', ')}</div>`
            : ''}`
          : 'no relays or power meters'
      const kind = f.kind === 'homekit'
        ? 'HomeKit firmware'
        : f.gen
          ? `Gen${f.gen}`
          : ''
      const addr = `${esc(f.host)}${f.host !== f.ip
        ? `<div class="muted" style="font-size:.85em">${esc(f.ip)}</div>`
        : ''}`
      const act = st.added
        ? `<span class="muted">Added</span>${st.canName
          ? ` <button class="btn btn-link btn-sm" data-usename="${esc(f.ip)}" data-to="${esc(f.host)}" title="Keep working when the router gives it a new address">Use its name</button>`
          : ''}`
        : f.password
          ? ''
          : `<button class="btn btn-link btn-sm" data-addfound="${esc(f.host)}">Add</button>`
      return `<tr><td>${esc(f.name || f.app || f.model || 'Shelly')}${st.meter ? ' <span class="pill">whole-house meter</span>' : ''}<div class="muted" style="font-size:.85em">${esc([f.model, kind].filter(Boolean).join(' · '))}</div></td><td>${what}</td><td>${addr}</td><td class="actions">${act}</td></tr>`
    }).join('')
    const fresh = F.filter(f => !f.password && !foundState(f).added)
    put(
      '#found',
      `<p style="margin:.5rem 0 .3rem">Found ${F.length} Shelly${F.length === 1
        ? ''
        : 's'} at ${FOUND.scanned} addresses on ${nets}${fresh.length
        ? `, ${fresh.length} not added yet`
        : ', all added'}.
        ${fresh.length > 1
    ? `<button class="btn btn-primary btn-sm" id="addAllFound">Add all ${fresh.length}</button>`
    : ''} <button class="btn btn-link btn-sm" id="closeFound">Close</button></p>
      <div class="scroll"><table><thead><tr><th>Shelly</th><th>What it gives</th><th>Address</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="help" style="margin:.3rem 0 0">A .local name is used where the Shelly has one that works from this computer, so it keeps working when your router gives it a new address.</p>`,
    )
  }
  async function doFind() {
    finding = true
    renderFound()
    $('#findShellys').disabled = true
    try {
      FOUND = await call('shellyFind')
    } catch (e) {
      if (!e.shown) {
        HB.toast.error(e.message, 'Find Shellys')
      }
    } finally {
      finding = false
      $('#findShellys').disabled = false
      renderFound()
    }
  }

  // Record readings: a day of the meter's readings and the devices' changes, to tune how appliances are found on real data
  function recCard() {
    const R = V.rec
    if (!R) {
      return ''
    }
    const kb = n => (n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`)
    const nice = n => n.replace(/^rec-|\.jsonl\.gz$/g, '').replace(/^(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)$/, '$1 $2:$3')
    return sec(
      'Record readings',
      'A day of readings, to check and tune how appliances are found.',
      'Every reading of the whole-house meter and every change of your Shellys and Matter devices. The copy kept on the Homebridge computer has your devices\' names; a download never does (devices are numbered, with only the kind of appliance each one powers) and never has addresses or rooms. An AI chat can then tell you what it shows: the steps are below once a recording has finished.',
      `
      ${
  R.on
    ? `<p>Recording since ${new Date(R.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, until ${new Date(R.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. <button class="btn btn-outline-secondary btn-sm" id="recStop">Stop now</button></p>`
    : '<div class="gap"><button class="btn btn-outline-secondary btn-sm" id="recStart">Record 24 hours</button><span class="help">A normal day is best: the more appliances run, the better.</span></div>'
  }
      ${
  R.list.length
    ? `<div class="scroll" style="margin-top:.4rem"><table><tbody>${R.list.map(f => `<tr><td>${esc(nice(f.name))}${f.recording ? ' <span class="pill on">recording</span>' : ''}</td><td class="num">${kb(f.size)}</td><td class="actions">${f.recording
      ? ''
      : `<button class="btn btn-link btn-sm" data-recdl="${esc(f.name)}">Download</button><button class="btn btn-link btn-sm" data-recrm="${esc(f.name)}" title="Delete">✕</button>`}</td></tr>`).join('')}</tbody></table></div>
        <div class="help">Kept in ${esc(R.folder)} (the newest 5). The Homebridge UI may not let the browser download it; the web page does.</div>`
    : ''
  }
      ${R.list.some(f => !f.recording)
    ? recSteps()
    : ''}`,
    )
  }
  // what to do with a downloaded recording: unzip it and give it to an AI chat with this prompt
  const REC_PROMPT = `I've attached a recording from my home energy monitor: a Shelly EM whole-house meter read every second for about a day, plus the smart plugs and switches it also reads. It's a text file of JSON lines.

The first line is a header: "start" is when it began (ms since 1970, UTC), "tzOffsetMin" is my time zone's offset from UTC in minutes (add it to get my local time), "threshold" is the smallest power step in watts the monitor pays attention to, and "format" describes the lines that follow:
- ["m", time, watts, reactive]: the whole house's power, once a second (reactive power in VAR, or null).
- ["d", time, device, kind, on, watts, type]: a plug or switch the monitor reads directly changed. Devices are numbered; "kind" (given the first time only) is the kind of appliance it powers where I've said, e.g. "kettle".

Please work it out from the data only, using my local time:
1. The day in brief: total kWh, the always-on (base) load in watts, the peak and when it happened.
2. The appliances you can pick out from the whole-house power that the numbered devices don't explain: for each, its likely kind (going by its watts, how long it runs, how often, the shape of its switch-on and the time of day, e.g. a fridge cycling, a kettle, an oven, a dryer, a heat pump), its typical watts, run length, runs in the day and kWh, and how sure you are.
3. What the numbered devices used.
4. Anything unusual: high standby, something running all night, a fridge or freezer that runs more than it should.
5. The three changes that would save the most, with the kWh each would save in a year.
Keep it short, and say when the data isn't enough to tell.`
  function recSteps() {
    return `<div class="note recsteps"><b>What to do with a recording</b>
      <ol><li>Download it with <b>Download</b> above.</li><li>Unzip it: double-click it (on a Mac or Windows). That gives a text file ending .jsonl. If your AI chat won't take that, rename it to end in .txt.</li>
        <li>Open an AI chat (Claude or another), attach the file and paste this prompt:</li></ol>
      <textarea class="form-control" id="recPrompt" readonly rows="6" spellcheck="false">${esc(REC_PROMPT)}</textarea>
      <div class="gap" style="margin-top:.4rem"><button class="btn btn-outline-secondary btn-sm" id="recCopy">Copy the prompt</button><span class="help">A download has no names, ids or addresses: devices are numbered, with only the kind of appliance each one powers.</span></div></div>`
  }
  async function recDownload(name) {
    try {
      const s = await HB.request('/rec/start', { name })
      if (!s.ok) {
        throw new Error(s.error)
      }
      let b64 = ''
      for (let i = 0; i < s.n; i++) b64 += await HB.request('/rec/piece', { id: s.id, i })
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }))
      a.download = name
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        URL.revokeObjectURL(a.href)
        a.remove()
      }, 1000)
    } catch (e) {
      HB.toast.error(e.message, 'Recording')
    }
  }

  // ---------- actions ----------
  document.addEventListener('click', async (ev) => {
    const fh = ev.target.closest('[data-fold]')
    if (fh) {
      return toggleFold(fh.dataset.fold)
    }
    const wm = ev.target.closest('[data-wkmode]')
    if (wm) {
      wkMode = wm.dataset.wkmode
      try {
        localStorage.setItem(WK_KEY, wkMode)
      } catch {}
      return renderWeek()
    }
    const RO = () => [...V.settings.rooms].sort(roomSort)
    const ru = ev.target.closest('[data-roomup],[data-roomdown]')
    if (ru) {
      const R = RO()
      const i = +(ru.dataset.roomup ?? ru.dataset.roomdown)
      const j = ru.dataset.roomup != null
        ? i - 1
        : i + 1
      if (j < 0 || j >= R.length) {
        return
      }
      ;[R[i], R[j]] = [R[j], R[i]]
      await act('roomOrder', { rooms: R })
      return
    }
    const rr = ev.target.closest('[data-roomren]')
    if (rr) {
      const from = rr.dataset.roomren
      const to = await ask(rr, `Rename "${from}" to:`, { input: from, ok: 'Rename' })
      if (to == null || !to.trim() || to.trim() === from) {
        return
      }
      const merge = V.settings.rooms.includes(to.trim())
      if (
        merge
        && !(await ask(rr, `There's already a room called "${to.trim()}". Put everything in "${from}" into it?`, {
          ok: 'Make them one',
        }))
      ) {
        return
      }
      await act(
        'roomRename',
        {
          from,
          to: to.trim(),
        },
        merge
          ? `"${from}" is now part of "${to.trim()}"`
          : `Renamed to "${to.trim()}"`,
      )
      return
    }
    const rm = ev.target.closest('[data-roomrm]')
    if (rm) {
      const r = rm.dataset.roomrm
      const k = V.sigs.filter(s => (s.room || '') === r).length
      if (
        !(await ask(rm, k
          ? `Remove "${r}"? Its ${plural(k, 'appliance')} will have no room.`
          : `Remove "${r}"?`, {
          ok: 'Remove',
          danger: true,
        }))
      ) {
        return
      }
      await act('roomRemove', { name: r }, `Removed "${r}"`)
      return
    }
    if (ev.target.id === 'roomAdd') {
      const v = $('#roomNew').value.trim()
      if (!v) {
        return HB.toast.error('Type the room\'s name', 'Shelly Home Energy')
      }
      if ((await act('roomAdd', { name: v }, `Added "${v}"`)) !== undefined) {
        $('#roomNew').value = ''
      }
      return
    }
    const tg = ev.target.closest('[data-todogone]')
    if (tg) {
      const o = todoGone()
      o[tg.dataset.todogone] = Date.now()
      try {
        localStorage.setItem(TODO_KEY, JSON.stringify(o))
      } catch {}
      $('#todo')._html = null
      return renderToday()
    }
    if (ev.target.closest('[data-setupdone]')) {
      try {
        localStorage.setItem('home-energy-setup-done', '1')
      } catch {}
      $('#todo')._html = null
      return renderToday()
    }
    if (ev.target.closest('[data-adddev]')) {
      openSec('sec-appl')
      addDev(true)
      return $('#shellyAdd').focus()
    }
    if (ev.target.closest('[data-devproblems]') || ev.target.closest('[data-goto="devprob"]')) {
      return showProblems()
    }
    const link = ev.target.closest('[data-goto]')
    if (link) {
      return openSec(link.dataset.goto)
    }
    const clr = ev.target.closest('[data-clearf]')
    if (clr) {
      const a = clr.dataset.clearf === 'a'
      for (const id of a
        ? ['aq', 'aroom', 'ashow']
        : ['dq', 'dshow']) {
        F[id] = ''
        $(`#${id}`).value = ''
      }
      saveF()
      return a
        ? renderAppl()
        : renderDev()
    }
    if (ev.target.id === 'recCopy') {
      // the clipboard can be blocked in the Homebridge UI's frame: then the text is selected to copy by hand
      const ta = $('#recPrompt')
      let ok = false
      try {
        await navigator.clipboard.writeText(ta.value)
        ok = true
      } catch {
        ta.focus()
        ta.select()
        try {
          ok = document.execCommand('copy')
        } catch {}
      }
      return ok
        ? HB.toast.success('Prompt copied', 'Shelly Home Energy')
        : HB.toast.error(
            'Copying isn\'t allowed here: the prompt is selected, so press ⌘C or Ctrl+C.',
            'Shelly Home Energy',
          )
    }
    if (ev.target.closest('[data-roomsedit]')) {
      // Edit rooms / Done: while editing, the whole list (no filters) and every room, empty ones too
      roomsEditing = !roomsEditing
      if (roomsEditing) {
        for (const id of ['aq', 'aroom', 'ashow']) {
          F[id] = ''
          $(`#${id}`).value = ''
        }
        saveF()
      }
      $('#appl')._html = null
      return renderAppl()
    }
    const b = ev.target.closest('button')
    if (!b || b.closest('.ask')) {
      return
    }
    const d = b.dataset
    if (d.edit) {
      editing = editing === d.edit
        ? null
        : d.edit
      naming = null
      otherDraft = null
      renderAppl()
    } else if (d.cancel !== undefined) {
      editing = null
      naming = null
      renderAppl()
      renderPat()
    } else if (d.save) {
      const f = $(`[data-form="${d.save}"]`)
      const g = k => f.querySelector(`[data-f="${k}"]`)?.value
      const st = g('steady')
      const room = roomOf(`ed-${d.save}`)
      if (room === null) {
        return HB.toast.error('Type the new room\'s name', 'Shelly Home Energy')
      }
      const o = {
        id: d.save,
        name: g('name'),
        icon: $(`#ic-${d.save}`).value || null,
        room,
        exposed: g('exposed') === '1',
        steadyOutlet: st === 'always'
          ? true
          : st === 'idle'
            ? 'idle'
            : false,
        steadyIdleMin: +g('idle') || 10,
        statusType: g('status'),
        statusCount: +g('count') || 1,
        alertLong: !!f.querySelector('[data-f="alertLong"]')?.checked,
      }
      const vb = f.querySelector('[data-f="variable"]')
      if (vb) {
        o.variable = vb.checked
      }
      if (g('runW') != null) {
        o.runW = g('runW') === ''
          ? null
          : +g('runW')
      }
      if (g('finishMin') != null) {
        o.finishMin = g('finishMin') === ''
          ? null
          : +g('finishMin')
      }
      // renamed to an appliance that already exists (a spa's heater named separately from its pump): offer to make them one
      // names are unique per room: "Downlights" can be in two rooms; only the same name in the same room is the same appliance
      const me = V.sigs.find(x => x.id === d.save)
      const other = V.sigs.find(
        x =>
          x.id !== d.save
          && x.name.trim().toLowerCase()
          === String(o.name || '')
            .trim()
            .toLowerCase()
            && (x.room || '') === (o.room ?? me.room ?? ''),
      )
      if (other) {
        if (me.devId || other.devId) {
          return HB.toast.error(
            `There's already an appliance called "${other.name}" in ${other.room || 'No room'}. Give it another room, or to count two devices as one, open "${other.name}" and use "Add another device to it".`,
            'Shelly Home Energy',
          )
        }
        if (
          !(await ask(
            b,
            `There's already an appliance called "${other.name}". Make "${me.name}" part of it? Its runs and energy move to "${other.name}"; where it runs while "${other.name}" is running, it counts as part of that run (a spa's heater during its pump's run, say). "${me.name}" and its Apple Home tiles are removed.`,
            { ok: 'Make them one' },
          ))
        ) {
          return
        }
        if (
          (await act('mergeSig', { from: me.id, into: other.id }, `"${me.name}" is now part of "${other.name}"`))
          !== undefined
        ) {
          editing = null
          renderAppl()
        }
        return
      }
      if ((await act('editSig', o, 'Saved')) === undefined) {
        return
      }
      if (g('estW') != null) {
        await act('estWatts', {
          id: d.save,
          watts: g('estW') === ''
            ? null
            : +g('estW'),
        })
      }
      editing = null
      renderAppl()
    } else if (d.untrack) {
      if (
        await ask(
          b,
          'Stop tracking its device? The appliance keeps its history and is recognised from whole-house steps again.',
          { ok: 'Stop tracking' },
        )
      ) {
        await act('untrack', { id: d.untrack }, 'Stopped tracking')
        editing = null
        renderAppl()
      }
    } else if (d.forget) {
      const s = V.sigs.find(x => x.id === d.forget)
      if (
        s
        && (await ask(
          b,
          `Forget "${s.name}"? Its tiles leave Apple Home (with any automations that use them) and its steps go back to unnamed. Its energy stays in the daily totals.`,
          { ok: 'Forget', danger: true },
        ))
      ) {
        await act('forgetSig', { id: d.forget }, 'Forgotten')
        editing = null
        renderAppl()
      }
    } else if (d.name) {
      naming = naming === d.name
        ? null
        : d.name
      editing = null
      renderPat()
      setTimeout(() => $('#nmName')?.focus(), 50)
    } else if (d.doname) {
      const name = $('#nmName').value.trim()
      if (!name) {
        return HB.toast.error('Give it a name', 'Shelly Home Energy')
      }
      const room = roomOf('nm')
      if (room === null) {
        return HB.toast.error('Type the new room\'s name', 'Shelly Home Energy')
      }
      if (
        (await act(
          'nameCluster',
          {
            key: d.doname,
            name,
            icon: $('#nmIcon').value || null,
            room,
          },
          `Named "${name}"`,
        )) !== undefined
      ) {
        naming = null
        renderPat()
        renderAppl()
      }
    } else if (d.yes) {
      const p = V.patterns.find(x => x.key === d.yes)
      if (p?.suggestion) {
        await act(
          'nameCluster',
          {
            key: p.key,
            name: p.suggestion.name,
            icon: p.suggestion.icon,
            sigId: p.suggestion.sig || null,
          },
          `Named "${p.suggestion.name}"`,
        )
      }
    } else if (d.no) {
      const p = V.patterns.find(x => x.key === d.no)
      if (p?.suggestion) {
        await act('dismiss', { name: p.suggestion.name, w: p.mean })
      }
    } else if (d.track) {
      const dv = V.devices.find(x => x.id === d.track)
      if (!dv) {
        return
      }
      let watts = null
      if (typeof dv.watts !== 'number') {
        const est = dv.est?.w
        const a = await ask(
          b,
          `"${dv.name}" doesn't measure its own power. Watts it uses when on${est
            ? ` (learned: about ${Math.round(est)} W; leave empty to use that)`
            : ''}:`,
          {
            input: '',
            placeholder: est
              ? String(Math.round(est))
              : 'watts',
            ok: 'Track',
          },
        )
        if (a === null) {
          return
        }
        if (a.trim()) {
          watts = +a.trim()
        } else if (!est) {
          return HB.toast.error('No learned figure yet: type its watts.', 'Shelly Home Energy')
        }
      }
      await act('track', { devId: dv.id, watts }, `Tracking "${dv.name}"`)
    } else if (d.combine) {
      const sel = $(`[data-combinesel="${d.combine}"]`)
      const dv = V.devices.find(x => x.id === sel?.value)
      const s = V.sigs.find(x => x.id === d.combine)
      if (!dv) {
        return HB.toast.error('Choose the device to add first', 'Shelly Home Energy')
      }
      let watts = null
      if (typeof dv.watts !== 'number' && s.estimated && !dv.est?.w) {
        const a = await ask(
          b,
          `"${dv.name}" only switches on and off, and no watts are learned for it yet. Watts it uses when on:`,
          { input: '', placeholder: 'watts', ok: 'Add' },
        )
        if (a === null) {
          return
        }
        if (!(+a > 0)) {
          return HB.toast.error('Type its watts', 'Shelly Home Energy')
        }
        watts = +a
      }
      if (
        (await act('combine', { id: d.combine, devId: dv.id, watts }, `${dv.name} added to "${s.name}"`)) !== undefined
      ) {
        document.activeElement?.blur?.()
        renderAppl()
      } // the open panel shows its devices now
    } else if (d.separate) {
      const s = V.sigs.find(x => x.id === d.sig)
      const x = s?.devs.find(y => y.id === d.separate)
      if (
        await ask(
          b,
          `Take ${x?.name || 'this device'} out of "${s?.name}"? ${s?.devs.length > 1
            ? 'The other devices stay part of it.'
            : ''} What it learned about its runs starts again.`,
          { ok: 'Take it out' },
        )
      ) {
        if ((await act('separate', { id: d.sig, devId: d.separate }, 'Taken out')) !== undefined) {
          document.activeElement?.blur?.()
          if (!V.sigs.find(x => x.id === d.sig)?.devId) {
            editing = null
          }
          renderAppl()
        }
      }
    } else if (d.dolink) {
      const sel = $(`[data-link="${d.dolink}"]`)
      const dv = V.devices.find(x => x.id === sel?.value)
      const s = V.sigs.find(x => x.id === d.dolink)
      if (!dv) {
        return HB.toast.error('Choose its device first', 'Shelly Home Energy')
      }
      let watts = null
      if (typeof dv.watts !== 'number') {
        // the device's own learned figure if it has one; otherwise what the appliance learned from whole-house steps, filled in
        const est = dv.est?.w
        const fromSteps = !est && s.watts > 0
          ? Math.round(s.watts)
          : null
        const a = await ask(
          b,
          `"${dv.name}" only switches on and off, so its watts come from ${est
            ? `what it learned: about ${Math.round(est)} W (leave empty to keep learning it, or type a figure)`
            : fromSteps
              ? `"${s.name}": about ${fromSteps} W learned from your meter (change it if you know better)`
              : 'you: type how many watts it uses when on'}.`,
          {
            input: fromSteps
              ? String(fromSteps)
              : '',
            placeholder: est
              ? String(Math.round(est))
              : 'watts',
            ok: 'Link',
          },
        )
        if (a === null) {
          return
        }
        if (a.trim()) {
          watts = +a.trim()
          if (!(watts > 0)) {
            return HB.toast.error('Type its watts as a number, like 300.', 'Shelly Home Energy')
          }
        } else if (!est) {
          return HB.toast.error('Type how many watts it uses when on, then press Link.', 'Shelly Home Energy')
        }
      }
      if (
        (await act('track', { devId: dv.id, watts, sigId: d.dolink }, `"${s.name}" is now measured by ${dv.name}`))
        !== undefined
      ) {
        editing = null
        renderAppl()
      }
    } else if (d.cyname) {
      const n = await ask(b, 'Name for this cycle', { input: d.cur, placeholder: 'Eco', ok: 'Rename' })
      if (n?.trim()) {
        await act('nameCycle', {
          id: d.sig,
          prog: d.cyname,
          name: n.trim(),
        }, 'Renamed')
      }
    } else if (d.cyforget) {
      if (
        await ask(b, 'Forget this cycle and the runs it was learned from? It\'s learned again if it runs again.', {
          ok: 'Forget',
          danger: true,
        })
      ) {
        await act('forgetCycle', { id: d.sig, prog: d.cyforget }, 'Forgotten')
      }
    } else if (d.forgetlearn) {
      if (
        await ask(
          b,
          'Forget the running level and finish wait learned for this appliance? It goes back to the defaults (5 W, 5 minutes) and learns again from its next runs.',
          { ok: 'Forget' },
        )
      ) {
        await act('forgetLearned', { id: d.forgetlearn }, 'Forgotten')
        renderAppl()
      }
    } else if (d.keep) {
      if ((await act('keepSteps', { id: d.keep }, 'Kept on steps')) !== undefined) {
        editing = null
        renderAppl()
      }
    } else if (d.tipno) {
      await act('dismissTip', { key: d.tipno })
    } else if (d.tipsmore !== undefined) {
      allTips = !allTips
      renderTips()
    } else if (d.tipsall !== undefined) {
      await act('dismissTip', {})
    } else if (d.hide) {
      await act('hideDevice', { id: d.hide, hide: true })
    } else if (d.unhide) {
      await act('hideDevice', { id: d.unhide, hide: false })
    } else if (d.allfound !== undefined) {
      allFound = !allFound
      renderPat()
    } else if (d.showhidden !== undefined) {
      showHidden = !showHidden
      renderPat()
    } else if (d.estreset) {
      if (await ask(b, 'Forget the readings learned for this device?', { ok: 'Forget them' })) {
        await act('estReset', { devId: d.estreset })
      }
    } else if (d.shrm) {
      if (
        await ask(
          b,
          `Stop reading the Shelly at ${d.shrm}? Appliances tracked through it stop getting readings until you track them again or add it back.`,
          { ok: 'Remove', danger: true },
        )
      ) {
        await act('setSettings', {
          shellyHosts: V.settings.shellyHosts.filter(h => h !== d.shrm),
        }, 'Removed')
      }
    } else if (d.mretry) {
      const code = await ask(b, 'Turn on pairing mode for the device in the Home app again, and paste the new code:', {
        input: '',
        placeholder: '1234-567-8901',
        ok: 'Pair',
      })
      if (code) {
        await act('matterRetry', { id: d.mretry, code }, 'Pairing…')
      }
    } else if (d.mremove) {
      const m = V.matter.find(x => x.id === d.mremove)
      if (
        m
        && (await ask(
          b,
          `Remove "${m.name}"? This plugin leaves the device; it stays in Apple Home. Appliances it measured go back to being recognised from steps.`,
          { ok: 'Remove', danger: true },
        ))
      ) {
        await act('matterRemove', { id: m.id }, 'Removed')
      }
    } else if (d.delper) {
      planDraft = readPlan()
      planDraft.periods.splice(+d.delper, 1)
      renderPlan(true)
    } else if (d.days) {
      sumDays = +d.days
      renderSummary()
    } else if (d.sumby) {
      sumBy = d.sumby
      renderSummary()
    } else if (d.impbk) {
      if (
        await ask(b, 'Import this backup? Appliances and history from it replace what came from any earlier import.', {
          ok: 'Import',
        })
      ) {
        await doImport(() => call('importBackup', { name: d.impbk }))
      }
    } else if (b.id === 'saveMeter') {
      try {
        await call('setSettings', {
          em: {
            host: $('#emHost').value.trim(),
            channel: $('#emChannel').value,
          },
          threshold: +$('#threshold').value || 40,
        })
        await saveConfigHost($('#emHost').value.trim())
        $('#meterMsg').textContent = ''
        saved('card-meter')
        HB.toast.success('Saved', 'Whole-house meter')
        await refresh(true)
      } catch (e) {
        if (!e.shown) {
          HB.toast.error(e.message)
        }
      }
    } else if (b.id === 'firstSetup') {
      firstSetup()
    } else if (b.id === 'recStart') {
      await act('recStart', { hours: 24 }, 'Recording for 24 hours')
    } else if (b.id === 'recStop') {
      await act('recStop', {}, 'Recording stopped')
    } else if (d.recdl) {
      recDownload(d.recdl)
    } else if (d.recrm) {
      if (await ask(b, 'Delete this recording?', { ok: 'Delete', danger: true })) {
        await act('recRemove', { name: d.recrm }, 'Deleted')
      }
    } else if (b.id === 'findShellys') {
      doFind()
    } else if (b.id === 'addDevBtn') {
      addDev()
    } else if (b.id === 'addDevClose') {
      addDev(false)
    } else if (b.id === 'closeFound') {
      FOUND = null
      renderFound()
    } else if (d.addfound) {
      await act('setSettings', {
        shellyHosts: [...V.settings.shellyHosts, d.addfound],
      }, 'Added')
    } else if (b.id === 'addAllFound') {
      const add = FOUND.found.filter(f => !f.password && !foundState(f).added).map(f => f.host)
      await act('setSettings', {
        shellyHosts: [
          ...V.settings.shellyHosts,
          ...add,
        ],
      }, `Added ${add.length} Shellys`)
    } else if (d.usename) {
      await act(
        'setSettings',
        {
          shellyHosts: V.settings.shellyHosts.map(h => (lc(h) === lc(d.usename)
            ? d.to
            : h)),
        },
        'Now using its name',
      )
    } else if (b.id === 'addShelly') {
      const v = $('#shellyAdd').value.trim()
      if (!v) {
        return HB.toast.error('Type the Shelly\'s address', 'Devices')
      }
      if (
        (await act('setSettings', {
          shellyHosts: [
            ...V.settings.shellyHosts,
            ...v.split(/[\s,;]+/),
          ],
        }, 'Added'))
        !== undefined
      ) {
        $('#shellyAdd').value = ''
      }
    } else if (b.id === 'addMatter') {
      const name = $('#mName').value.trim()
      const code = $('#mCode').value.trim()
      if (!name || !code) {
        return HB.toast.error('Give it a name and paste its pairing code', 'Matter')
      }
      if ((await act('matterAdd', { name, code }, 'Pairing… this can take a minute')) !== undefined) {
        $('#mName').value = ''
        $('#mCode').value = ''
      }
    } else if (b.id === 'addPer') {
      planDraft = readPlan()
      planDraft.periods.push({
        name: 'Weekend',
        from: 0,
        to: 24,
        days: 'weekends',
        rate: 0,
      })
      renderPlan(true)
    } else if (b.id === 'savePlan') {
      const T = readPlan()
      const cheap = $('#pCheap')
        ? $('#pCheap').checked && T.mode === 'tou' && T.periods.length > 0
        : false
      const budget = +($('#pBudget')?.value || 0)
      if (!(budget >= 0)) {
        return HB.toast.error('The budget is a number, like 250', 'Shelly Home Energy')
      }
      if (
        (await act(
          'setSettings',
          {
            tariff: T,
            currency: $('#pCur').value || '$',
            billDay: +($('#pBillDay')?.value || 1),
            cheapTile: cheap,
            budget,
            budgetTile: !!$('#pBudgetTile')?.checked && budget > 0,
          },
          'Plan saved',
        )) !== undefined
      ) {
        planDraft = null
        saved('card-plan')
        renderPlan(true)
        renderSummary()
      }
    } else if (d.mrefresh) {
      if (
        await ask(
          b,
          `Publish "${d.mname}" to Apple Home again as a new outlet? The current one disappears from the Home app, and the new one appears within a minute or so, in your default room. Put it in its room again, and redo any automations or scenes that used it.`,
          { ok: 'Refresh in Apple Home' },
        )
      ) {
        await act(
          'matterRefresh',
          { id: d.mrefresh },
          `"${d.mname}" published again: look for it in the Home app in a minute or so`,
        )
      }
    } else if (b.id === 'saveTiles') {
      if (
        (await act('setSettings', {
          other: { on: $('#tOther').checked, name: $('#tOtherName').value },
        }, 'Saved'))
        !== undefined
      ) {
        otherDraft = null
        editing = null
        renderAppl()
      }
    } else if (b.id === 'export') {
      doExport()
    } else if (b.id === 'saveWebPin') {
      const pin = $('#webPin').value
      if ((await act('webSetPin', { pin }, 'PIN saved')) !== undefined) {
        $('#webPin').value = ''
      }
    } else if (b.id === 'webSignOut') {
      if (await ask(b, 'Sign every browser out of the web page? They need the PIN again.', { ok: 'Sign out' })) {
        await act('webSignOutAll', {}, 'Signed out')
      }
    }
  })
  document.addEventListener('change', (ev) => {
    if (ev.target.matches?.('[data-iconsel]')) {
      const p = ev.target.previousElementSibling
      if (p?.matches('[data-icoprev]')) {
        p.innerHTML = icon(ev.target.value)
      }
    }
  })
  // a Settings card with a Save button: "Not saved yet" from the first change until it's saved
  const markDirty = (ev) => {
    const c = ev.target.closest?.('[data-savecard]')
    if (c && ev.target.matches('input, select, textarea')) {
      c.classList.add('dirty')
    }
  }
  document.addEventListener('input', markDirty)
  document.addEventListener('change', markDirty)
  const saved = id => $(`#${id}`)?.classList.remove('dirty')
  document.addEventListener(
    'toggle',
    (ev) => {
      if (ev.target.matches?.('details.recog')) {
        try {
          localStorage.setItem(RECOG_KEY, ev.target.open ? '1' : '0')
        } catch {}
      }
    },
    true,
  )
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'shellyAdd') {
      $('#addShelly').click()
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset?.fold) {
      ev.preventDefault()
      toggleFold(ev.target.dataset.fold)
    }
  })
  document.addEventListener('input', (ev) => {
    if (ev.target.closest?.('[data-otherform]')) {
      otherDraft = { on: $('#tOther').checked, name: $('#tOtherName').value }
    } // kept through refreshes
    const id = ev.target.id
    if (!['aq', 'aroom', 'ashow', 'dq', 'dshow'].includes(id)) {
      return
    }
    F[id] = ev.target.value
    saveF()
    if (V) {
      if (id[0] === 'a') {
        renderAppl()
      } else {
        renderDev()
      }
    }
  })
  document.addEventListener('change', async (ev) => {
    // a device's room in Found: saved as soon as it's chosen (a new room once its name is typed)
    const dv = ev.target.closest('[data-roompick^="dv-"]')
    if (
      dv
      && (ev.target.matches('[data-roomnew]') || (ev.target.matches('[data-roomsel]') && ev.target.value !== '__new'))
    ) {
      const room = roomOf(dv.dataset.roompick)
      if (room != null) {
        act('setDevRoom', {
          id: dv.dataset.roompick.slice(3),
          room,
        }, room
          ? `Room: ${room}`
          : 'No room').then(() =>
          refresh(true),
        )
      }
      if (ev.target.matches('[data-roomnew]')) {
        return
      }
    }
    if (ev.target.matches('[data-roomsel]')) {
      const box = ev.target.parentElement.querySelector('[data-roomnew]')
      const nw = ev.target.value === '__new'
      box.style.display = nw ? '' : 'none'
      if (nw) {
        box.focus()
      }
      return
    }
    if (ev.target.id === 'pMode') {
      planDraft = readPlan()
      planDraft.mode = ev.target.value
      if (planDraft.mode === 'tou' && !planDraft.periods.length) {
        planDraft.periods.push({
          name: 'Night',
          from: 21,
          to: 7,
          days: 'all',
          rate: 0,
        })
      }
      renderPlan(true)
    } else if (ev.target.id === 'pNFrom' || ev.target.id === 'pNTo') {
      const f = +$('#pNFrom').value
      const t = +$('#pNTo').value
      $('#pDayHours').textContent
        = f === t
          ? 'Night covers no hours: set its hours.'
          : `${hourText(t)}–${hourText(f)}, every hour that isn't night`
      planDraft = readPlan()
    } else if (ev.target.closest('#plan') && ev.target.id !== 'pCheap') {
      planDraft = readPlan()
    }
    if (ev.target.id === 'webRO') {
      await act(
        'webSet',
        { readOnly: ev.target.checked },
        ev.target.checked ? 'The web page is now view-only' : 'The web page can change things again',
      )
      return
    }
    if (ev.target.id === 'webOn') {
      await act('webSet', { on: ev.target.checked }, ev.target.checked ? 'Web page on' : 'Web page off')
      return
    }
    if (ev.target.id === 'impFile' && ev.target.files[0]) {
      const f = ev.target.files[0]
      ev.target.value = ''
      if (
        await ask(
          ev.target.closest('.gap'),
          `Import "${f.name}"? Appliances and history from it replace what came from any earlier import.`,
          { ok: 'Import' },
        )
      ) {
        doImport(() => upload(f))
      }
    }
  })

  async function doImport(run) {
    HB.showSpinner()
    try {
      const r = await run()
      HB.toast.success(
        `Imported ${r.counts.appliances} appliances and ${r.counts.days} days of energy.`,
        'Shelly Home Energy',
      )
      await refresh(true)
    } catch (e) {
      if (!e.shown) {
        HB.toast.error(e.message, 'Import')
      }
    } finally {
      HB.hideSpinner()
    }
  }
  async function upload(file) {
    if (file.size > 80 * 1024 * 1024) {
      throw new Error('That file is too large to be an export.')
    }
    const text = await file.text()
    $('#impMsg').textContent = 'Sending…'
    const st = await HB.request('/upload/start', { size: text.length, name: file.name })
    for (let i = 0, k = 0; i < text.length; i += st.piece, k++) {
      await HB.request('/upload/piece', {
        id: st.id,
        i: k,
        data: text.slice(i, i + st.piece),
      })
    }
    $('#impMsg').textContent = ''
    const r = await HB.request('/upload/finish', { id: st.id })
    if (!r.ok) {
      throw new Error(r.error)
    }
    return r.result
  }
  async function doExport() {
    const btn = $('#export')
    if (btn) {
      btn.disabled = true
    }
    try {
      const s = await HB.request('/export/start', {})
      if (!s.ok) {
        throw new Error(s.error)
      }
      let text = ''
      for (let i = 0; i < s.n; i++) text += await HB.request('/export/piece', { id: s.id, i })
      await refresh(true)
      HB.toast.success(
        `Saved on the Homebridge computer as ${s.savedAs}, in ${s.folder}. It's listed under Import from backup.`,
        'Backup',
      )
      // the Homebridge UI shows this page in a frame that may not allow downloads; the copy above is kept either way
      try {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        a.download = s.savedAs
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          URL.revokeObjectURL(a.href)
          a.remove()
        }, 1000)
      } catch {}
    } catch (e) {
      HB.toast.error(e.message, 'Backup')
    } finally {
      if (btn) {
        btn.disabled = false
      }
    }
  }
  // config.json: keep the Shelly EM address there too (used on a fresh start)
  async function pluginConfig() {
    const c = await HB.getPluginConfig()
    return c.length
      ? c
      : [
          { platform: 'ShellyHomeEnergy', name: 'Shelly Home Energy' },
        ]
  }
  async function saveConfig(c) {
    await HB.updatePluginConfig(c)
    if (typeof HB.savePluginConfig === 'function') {
      await HB.savePluginConfig()
    }
  }
  async function saveConfigHost(host) {
    if (HB.web) {
      return
    }
    try {
      const c = await pluginConfig()
      if (c[0].host === host) {
        return
      }
      c[0].host = host || undefined
      await saveConfig(c)
    } catch (e) {
      console.warn(e)
    }
  }
  refresh(true).then(() => renderSummary())
  setInterval(() => {
    if (!document.hidden) {
      refresh()
      if ($('#sec-today').open && Date.now() - (renderSummary.at || 0) > 30000) {
        renderSummary.at = Date.now()
        renderSummary()
      }
    }
  }, 3000)
})()
