// A stand-in Shelly running the open HomeKit firmware: GET /rpc/Shelly.GetInfoExt and POST /rpc/Shelly.SetState,
// shaped like a real Shelly 1 (2.16.1), with identifying values blanked. `pm: true` adds apower/aenergy like a 1PM.
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

// A stand-in Shelly Gen2+ (stock firmware, e.g. a Plus Plug S): GetDeviceInfo, GetConfig, GetStatus. Values made up.
export function startFakeGen2(
  port,
  { id = 'shellyplusplugs-test01', name = 'Washing machine', channels = 1, meterOnly = false, password = false } = {},
) {
  const st = {
    on: Array.from({ length: channels }).fill(false),
    w: Array.from({ length: channels }).fill(0),
    down: false,
    gets: 0,
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
        c[`${meterOnly ? 'pm1' : 'switch'}:${i}`] = {
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
      const s = { sys: {} }
      for (let i = 0; i < channels; i++) {
        s[`${meterOnly ? 'pm1' : 'switch'}:${i}`] = meterOnly
          ? { id: i, apower: st.w[i], voltage: 230 }
          : {
              id: i,
              output: st.on[i],
              apower: st.on[i] ? st.w[i] : 0,
              voltage: 230,
            }
      }
      return send(200, s)
    }
    send(404, { code: 404, message: 'not found' })
  })
  server.listen(port, '127.0.0.1')
  return {
    st,
    close: () => server.close(),
  }
}

// A stand-in Shelly EM Gen4: GetStatus with em1:0 / em1:1 (act_power). `w` is what clamp 1 reads.
export function startFakeEm(port) {
  const st = { w: 350, w2: 0, down: false, gets: 0 }
  const server = http.createServer((req, res) => {
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
    res.end(
      JSON.stringify({
        'em1:0': {
          id: 0,
          current: st.w / 230,
          voltage: 230.1,
          act_power: st.w,
          aprt_power: st.w,
          pf: 0.98,
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
      }),
    )
  })
  server.listen(port, '127.0.0.1')
  return {
    st,
    close: () => server.close(),
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
