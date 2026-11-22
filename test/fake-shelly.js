// A stand-in Shelly running the open HomeKit firmware: GET /rpc/Shelly.GetInfoExt and POST /rpc/Shelly.SetState,
// shaped like a real Shelly 1 (2.16.1), with identifying values blanked. `pm: true` adds apower/aenergy like a 1PM.
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import http from 'node:http'

export function startFakeShelly(
  port,
  { id = 'shelly1-TEST01', name = 'Front Door', pm = false, password = false } = {},
) {
  const st = { state: false, sets: [], gets: 0 }
  const info = () => ({
    device_id: id,
    name: id,
    app: 'switch1',
    model: pm ? 'Shelly1PM' : 'Shelly1',
    stock_fw_model: 'SHSW-1',
    host: '',
    version: '2.16.1',
    auth_en: password,
    hap_paired: true,
    hap_ip_conns_active: 1,
    hap_ip_conns_max: 12,
    wifi_connected: true,
    mac_address: '',
    components: [
      {
        id: 1,
        type: 0,
        name,
        svc_type: 0,
        hk_state_inverted: false,
        in_mode: 1,
        initial: 3,
        state: st.state,
        auto_off: false,
        ...(pm
          ? {
              apower: st.state ? 61.5 : 0,
              aenergy: 1234,
            }
          : {}),
      },
    ],
  })
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(body === undefined
        ? 'null'
        : JSON.stringify(body))
    }
    if (password) {
      return send(401, { code: 401, message: 'Unauthorized' })
    }
    if (req.url.startsWith('/rpc/Shelly.GetInfoExt')) {
      st.gets++
      return send(200, info())
    }
    if (req.url.startsWith('/rpc/Shelly.SetState') && req.method === 'POST') {
      let b = ''
      req.on('data', c => (b += c))
      req.on('end', () => {
        let j = {}
        try {
          j = JSON.parse(b)
        } catch {}
        if (j.id !== 1 || j.type !== 0 || typeof j.state?.state !== 'boolean') {
          return send(200, { code: 400, message: 'component not found' })
        }
        st.state = j.state.state
        st.sets.push(j)
        send(200)
      })
      return
    }
    send(404, { code: 404, message: 'not found' })
  })
  server.listen(port, '127.0.0.1')
  return {
    st,
    close: () => server.close(),
  }
}

// A minimal WebSocket server for the stand-ins (RFC 6455: handshake, text frames, ping, close), so the plugin's live
// connection is tested against the real browser-standard client in Node. onText(text, sendText) per message; returns the
// set of open sockets, each with .sendText(text).
export function attachWs(server, path, onText) {
  const socks = new Set()
  server.on('upgrade', (req, sock) => {
    if (req.url !== path || !req.headers['sec-websocket-key']) {
      sock.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    sock.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const frame = (op, data) => {
      const b = Buffer.from(data)
      const h
        = b.length < 126
          ? Buffer.from([0x80 | op, b.length])
          : b.length < 65536
            ? Buffer.from([
                0x80 | op,
                126,
                b.length >> 8,
                b.length & 255,
              ])
            : null
      if (h && !sock.destroyed) {
        sock.write(Buffer.concat([h, b]))
      }
    }
    sock.sendText = t => frame(1, t)
    socks.add(sock)
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 2) {
          return
        }
        const op = buf[0] & 15
        let len = buf[1] & 127
        let off = 2
        if (len === 126) {
          if (buf.length < 4) {
            return
          }
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          sock.destroy()
          return
        }
        if (buf.length < off + 4 + len) {
          return
        }
        const mask = buf.subarray(off, off + 4)
        const body = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i % 4])
        buf = buf.subarray(off + 4 + len)
        if (op === 8) {
          frame(8, Buffer.alloc(0))
          sock.end()
          return
        }
        if (op === 9) {
          frame(10, body)
          continue
        }
        if (op === 1) {
          onText(body.toString('utf8'), sock.sendText)
        }
      }
    })
    sock.on('close', () => socks.delete(sock))
    sock.on('error', () => socks.delete(sock))
  })
  return socks
}

// A stand-in Shelly Gen2+ (stock firmware, e.g. a Plus Plug S): GetDeviceInfo, GetConfig, GetStatus, and the live connection
// (WebSocket /rpc) unless `ws: false` or a password is set. Values made up.
export function startFakeGen2(
  port,
  {
    id = 'shellyplusplugs-test01',
    name = 'Washing machine',
    channels = 1,
    meterOnly = false,
    password = false,
    ws = true,
  } = {},
) {
  const st = {
    on: Array.from({ length: channels }).fill(false),
    w: Array.from({ length: channels }).fill(0),
    down: false,
    gets: 0,
    wsGets: 0,
    pushes: 0,
  }
  const comp = i => `${meterOnly ? 'pm1' : 'switch'}:${i}`
  const status = () => {
    const s = { sys: {} }
    for (let i = 0; i < channels; i++) {
      s[comp(i)] = meterOnly
        ? { id: i, apower: st.w[i], voltage: 230 }
        : {
            id: i,
            output: st.on[i],
            apower: st.on[i] ? st.w[i] : 0,
            voltage: 230,
          }
    }
    return s
  }
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (st.down) {
      req.socket.destroy()
      return
    }
    const m = req.url.replace(/\?.*$/, '')
    // like the real ones: /shelly always answers, and says whether a password is set
    if (m === '/shelly') {
      return send(200, {
        name: null,
        id,
        mac: '',
        model: 'SNPL-00112EU',
        gen: 2,
        fw_id: 'test',
        ver: '1.4.4',
        app: 'PlusPlugS',
        auth_en: password,
      })
    }
    if (password) {
      return send(401, { code: 401, message: 'Unauthorized' })
    }
    if (m === '/rpc/Shelly.GetInfoExt') {
      return send(404, { code: 404, message: 'No handler for Shelly.GetInfoExt' })
    }
    if (m === '/rpc/Shelly.GetDeviceInfo') {
      return send(200, {
        name: null,
        id,
        mac: '',
        slot: 0,
        model: 'SNPL-00112EU',
        gen: 2,
        fw_id: 'test',
        ver: '1.4.4',
        app: 'PlusPlugS',
        auth_en: false,
      })
    }
    if (m === '/rpc/Shelly.GetConfig') {
      const c = {
        sys: {
          device: { name: null },
        },
      }
      for (let i = 0; i < channels; i++) {
        c[comp(i)] = {
          id: i,
          name: i
            ? `${name} ${i + 1}`
            : name,
        }
      }
      return send(200, c)
    }
    if (m === '/rpc/Shelly.GetStatus') {
      st.gets++
      return send(200, status())
    }
    send(404, { code: 404, message: 'not found' })
  })
  // the live connection: requests answered; changes pushed as NotifyStatus (only the parts that changed), like the real ones
  let last = JSON.stringify(status())
  let clientSrc = null
  const socks
    = ws && !password
      ? attachWs(server, '/rpc', (text, reply) => {
          let m
          try {
            m = JSON.parse(text)
          } catch {
            return
          }
          if (st.down) {
            return
          }
          clientSrc = m.src || clientSrc
          if (m.method === 'Shelly.GetStatus') {
            st.wsGets++
            reply(JSON.stringify({
              id: m.id,
              src: id,
              dst: m.src,
              result: status(),
            }))
          } else {
            reply(JSON.stringify({
              id: m.id,
              src: id,
              dst: m.src,
              error: { code: 404, message: 'No handler' },
            }))
          }
        })
      : new Set()
  const timer = setInterval(() => {
    const now = status()
    const cur = JSON.stringify(now)
    if (cur === last || st.down) {
      return
    }
    const prev = JSON.parse(last)
    const params = { ts: Date.now() / 1000 }
    last = cur
    for (const [k, v] of Object.entries(now)) {
      const ch = {}
      for (const [f, x] of Object.entries(v)) {
        if (prev[k]?.[f] !== x) {
          ch[f] = x
        }
      }
      if (Object.keys(ch).length) {
        params[k] = { id: v.id, ...ch }
      }
    }
    for (const s2 of socks) {
      if (clientSrc) {
        st.pushes++
        s2.sendText(JSON.stringify({
          src: id,
          dst: clientSrc,
          method: 'NotifyStatus',
          params,
        }))
      }
    }
  }, 100)
  server.listen(port, '127.0.0.1')
  return {
    st,
    socks,
    close: () => {
      clearInterval(timer)
      for (const x of socks) x.destroy()
      server.close()
    },
  }
}

// A stand-in Shelly EM Gen4: GetStatus with em1:0 / em1:1 (act_power, aprt_power). `w` is what clamp 1 reads; `q` its reactive
// power (VAR), so aprt_power = √(w² + q²) and the power factor follows
export function startFakeEm(port, { ws = true } = {}) {
  const st = {
    w: 350,
    q: 70,
    w2: 0,
    wh: 123456.5,
    wh2: 10,
    down: false,
    tries: 0,
    gets: 0,
    wsGets: 0,
    pushes: 0,
    mute: false,
  }
  const status = () => {
    const s = Math.round(Math.hypot(st.w, st.q) * 10) / 10
    return {
      'em1:0': {
        id: 0,
        current: s / 230,
        voltage: 230.1,
        act_power: st.w,
        aprt_power: s,
        pf: Math.round((st.w / (s || 1)) * 100) / 100,
        freq: 50,
      },
      'em1:1': {
        id: 1,
        current: 0,
        voltage: 230.1,
        act_power: st.w2,
        aprt_power: 0,
        pf: 0,
        freq: 50,
      },
      'em1data:0': { id: 0, total_act_energy: st.wh, total_act_ret_energy: 0 },
      'em1data:1': { id: 1, total_act_energy: st.wh2, total_act_ret_energy: 0 },
    }
  }
  const server = http.createServer((req, res) => {
    st.tries++
    if (st.down) {
      req.socket.destroy()
      return
    }
    if (!req.url.startsWith('/rpc/Shelly.GetStatus')) {
      res.writeHead(404)
      return res.end()
    }
    st.gets++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status()))
  })
  // live connection, like a real Gen4 EM: requests answered; act_power changes pushed as NotifyStatus. st.mute: silent (a stuck one)
  let src = null
  let last = JSON.stringify(status())
  const socks = ws
    ? attachWs(server, '/rpc', (text, reply) => {
        let m
        try {
          m = JSON.parse(text)
        } catch {
          return
        }
        if (st.mute || st.down) {
          return
        }
        src = m.src || src
        if (m.method === 'Shelly.GetStatus') {
          st.wsGets++
          reply(JSON.stringify({
            id: m.id,
            src: 'shellyemg4-test',
            dst: m.src,
            result: status(),
          }))
        }
      })
    : new Set()
  const timer = setInterval(() => {
    const cur = JSON.stringify(status())
    if (cur === last || st.mute || st.down || !src) {
      last = cur
      return
    }
    last = cur
    const now = status()
    for (const x of socks) {
      st.pushes++
      x.sendText(
        JSON.stringify({
          src: 'shellyemg4-test',
          dst: src,
          method: 'NotifyStatus',
          params: {
            'ts': Date.now() / 1000,
            'em1:0': { id: 0, act_power: now['em1:0'].act_power },
            'em1:1': { id: 1, act_power: now['em1:1'].act_power },
          },
        }),
      )
    }
  }, 100)
  server.listen(port, '127.0.0.1')
  return {
    st,
    socks,
    close: () => {
      clearInterval(timer)
      for (const x of socks) x.destroy()
      server.close()
    },
  }
}

// A stand-in Shelly Gen2+ with any parts: `status()` returns the GetStatus body (e.g. cover:0, light:0, em1:1), `config` the names.
export function startFakeRpc(port, { id = 'shellytest-rpc01', model = 'S3SW-002P16EU', status, config = {} }) {
  const st = { down: false }
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (st.down) {
      req.socket.destroy()
      return
    }
    const m = req.url.replace(/\?.*$/, '')
    if (m === '/shelly') {
      return send(200, {
        id,
        mac: '',
        model,
        gen: 3,
        app: 'Test',
        auth_en: false,
      })
    }
    if (m === '/rpc/Shelly.GetDeviceInfo') {
      return send(200, {
        name: null,
        id,
        mac: '',
        model,
        gen: 3,
        app: 'Test',
      })
    }
    if (m === '/rpc/Shelly.GetConfig') {
      return send(200, {
        sys: {
          device: { name: null },
        },
        ...config,
      })
    }
    if (m === '/rpc/Shelly.GetStatus') {
      return send(200, status())
    }
    send(404, { code: 404, message: 'No handler' })
  })
  server.listen(port, '127.0.0.1')
  return {
    st,
    close: () => server.close(),
  }
}

// A stand-in Gen1 Shelly on Shelly's own firmware: GET /shelly (no "gen"), /settings and /status, shaped like the real ones.
// type: 'SHSW-PM' (1PM), 'SHEM' (EM: two clamps + contactor relay), 'SHEM-3' (3EM), 'SHSW-25' in roller mode, 'SHDM-2' (Dimmer 2)
export function startFakeGen1(port, { type = 'SHSW-PM', name = null, auth = false, mac = 'A1B2C3D4E5F6' } = {}) {
  const st = {
    on: false,
    w: 0,
    em: [350, 20, 0],
    down: false,
  }
  const status = () => {
    if (type === 'SHSW-PM') {
      return {
        relays: [
          { ison: st.on },
        ],
        meters: [
          {
            power: st.on ? st.w : 0,
            is_valid: true,
          },
        ],
      }
    }
    if (type === 'SHSW-1') {
      return {
        relays: [
          { ison: st.on },
        ],
      } // a Shelly 1: a relay, no power meter
    }
    if (type === 'SHEM') {
      return {
        relays: [
          { ison: false },
        ],
        emeters: st.em.slice(0, 2).map(p => ({ power: p, is_valid: true, voltage: 230 })),
      }
    }
    if (type === 'SHEM-3') {
      return {
        relays: [
          { ison: false },
        ],
        emeters: st.em.map(p => ({ power: p, is_valid: true, voltage: 230 })),
      }
    }
    if (type === 'SHSW-25') {
      return {
        rollers: [
          {
            state: st.on ? 'open' : 'stop',
            power: st.on ? st.w : 0,
          },
        ],
        meters: [
          {
            power: st.on ? st.w : 0,
            is_valid: true,
          },
          { power: 0, is_valid: true },
        ],
      }
    }
    if (type === 'SHDM-2') {
      return {
        lights: [
          { ison: st.on, brightness: 60 },
        ],
        meters: [
          {
            power: st.on ? st.w : 0,
            is_valid: true,
          },
        ],
      }
    }
    return {}
  }
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (st.down) {
      req.socket.destroy()
      return
    }
    const m = req.url.replace(/\?.*$/, '')
    if (m === '/shelly') {
      return send(200, {
        type,
        mac,
        auth,
        fw: '20230913-114008/v1.14.0-gcb84623',
        num_outputs: 1,
      })
    }
    if (auth) {
      res.writeHead(401)
      return res.end('401 Unauthorized')
    }
    if (m === '/settings') {
      return send(200, {
        name,
        device: { type, hostname: 'shelly-test' },
        relays: [
          {
            name: type === 'SHSW-PM'
              ? 'Heater'
              : null,
          },
        ],
        rollers: [{}],
        lights: [
          { name: null },
        ],
        emeters: [
          { name: null },
          { name: 'Hot water' },
          {},
        ],
      })
    }
    if (m === '/status') {
      return send(200, status())
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found') // Gen1 has no /rpc
  })
  server.listen(port, '127.0.0.1')
  return {
    st,
    close: () => server.close(),
  }
}
