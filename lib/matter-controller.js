// Matter controller helper. Runs as its own child process (forked by lib/matter-devices.js) so matter.js's process-wide
// state can never interfere with Homebridge or with Homebridge's own Matter bridge.
//
// It joins Matter devices that are already in Apple Home as a second controller (Matter multi-admin) and reads them:
// watts (Electrical Power Measurement 0x0090), on/off (0x0006) and, on hubs, their sensors. It only reads; it never switches.
// The matter.js calls follow homebridge-appliance-monitor by Oliver Rummeyer (MIT licence),
// https://github.com/rummeyer/homebridge-appliance-monitor
//
// Messages from the plugin: { cmd: 'pair', id, code } · { cmd: 'connect', nodeId } · { cmd: 'unpair', nodeId } · { cmd: 'stop' }
// Messages to the plugin:   { ev: 'ready', nodes } · { ev: 'paired', id, nodeId } · { ev: 'pairFailed', id, error }
//                           { ev: 'state', nodeId, state } · { ev: 'info', nodeId, product, devices: [{ endpoint, name, types, clusters }] }
//                           { ev: 'value', nodeId, endpoint, key, value } · { ev: 'log', level, msg } · { ev: 'fatal', error }
// One device per bridged endpoint (or per endpoint with readings, on a plain device), worked out by lib/matter-hub.js,
// which also keeps the GRILLPLATS rule: when several endpoints report power, one without a relay (OnOff) is a mirror and ignored.
// The storage id and fabric label are fixed: changing them would lose every pairing, so they keep their original names.
import process from 'node:process'

const ELECTRICAL_POWER_MEASUREMENT = 0x0090
const ACTIVE_POWER = 0x0008
const hubGroup = new Map() // nodeId -> Map(endpoint -> bridged device endpoint)
let H // lib/matter-hub.js, loaded in boot()
const POLL_IF_QUIET_MS = 20000 // some plugs (e.g. Eve Energy) only report about once a minute

function send(m) {
  try {
    process.send?.(m)
  } catch {}
}
function log(level, msg) {
  return send({
    ev: 'log',
    level,
    msg: String(msg),
  })
}

const storagePath = process.argv[2]
const logLevel = process.argv[3] || 'warn'

let M // matter.js modules, loaded after the process-wide config is set
let controller
const nodes = new Map() // nodeId (string) -> PairedNode
const lastReport = new Map() // `${nodeId}:${endpoint}` -> time of last power report

async function boot() {
  // Must happen before @matter/main is first imported: stop matter.js reading config.json from the
  // working directory (Homebridge's), parsing argv, or installing its own signal/error handlers.
  const { config } = await import('@matter/nodejs/config')
  config.loadConfigFile = false
  config.loadProcessArgv = false
  config.trapProcessSignals = false
  config.trapUnhandledErrors = false
  config.setProcessExitCodeOnError = false

  const main = await import('@matter/main')
  const clusters = await import('@matter/main/clusters')
  const types = await import('@matter/main/types')
  const pm = await import('@project-chip/matter.js')
  const device = await import('@project-chip/matter.js/device')
  H = await import('./matter-hub.js')
  M = {
    ...main,
    GeneralCommissioning: clusters.GeneralCommissioning,
    NodeId: types.NodeId,
    ManualPairingCodeCodec: types.ManualPairingCodeCodec,
    QrPairingCodeCodec: types.QrPairingCodeCodec,
    CommissioningController: pm.CommissioningController,
    NodeStates: device.NodeStates,
  }

  // Send matter.js's log lines to the plugin (and so to the Homebridge log)
  const EXPECTED = [
    /Using development values for some BasicInformation attributes/,
    /Using test vendor ID/,
    /BLE is not enabled/,
    /Attestation finding accepted/,
  ]
  M.Logger.format = 'plain'
  try {
    M.Logger.level = M.LogLevel(logLevel)
  } catch {}
  const dest = M.Logger.destinations?.default
  if (dest) {
    dest.write = (formatted, message) => {
      const text = String(formatted).replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [A-Z]+ /, '')
      const lvl = EXPECTED.some(p => p.test(text))
        ? 'debug'
        : message.level >= M.LogLevel.ERROR
          ? 'error'
          : message.level >= M.LogLevel.WARN
            ? 'warn'
            : 'debug'
      log(lvl, text)
    }
  }

  M.Environment.default.vars.set('storage.path', storagePath)
  controller = new M.CommissioningController({
    environment: { environment: M.Environment.default, id: 'shelly-appliances' },
    autoConnect: false,
    adminFabricLabel: 'Shelly Appliances',
  })
  await controller.start()
  send({
    ev: 'ready',
    nodes: controller.getCommissionedNodes().map(n => String(n)),
  })
  setInterval(pollQuiet, 5000)
}

// Reads the 11-digit code the Home app shows (dashes/spaces allowed), or an "MT:" QR payload.
function parsePairingCode(code) {
  const trimmed = String(code || '').trim()
  try {
    if (/^MT:/i.test(trimmed)) {
      const [data] = M.QrPairingCodeCodec.decode(trimmed.toUpperCase())
      return data
        ? {
            passcode: data.passcode,
            identifier: { longDiscriminator: data.discriminator },
          }
        : undefined
    }
    const digits = trimmed.replace(/[\s-]/g, '')
    if (!/^(?:\d{11}|\d{21})$/.test(digits)) {
      return undefined
    }
    const data = M.ManualPairingCodeCodec.decode(digits)
    if (data.shortDiscriminator === undefined) {
      return undefined
    }
    return {
      passcode: data.passcode,
      identifier: { shortDiscriminator: data.shortDiscriminator },
    }
  } catch {
    return undefined
  }
}

async function pair(id, code) {
  const data = parsePairingCode(code)
  if (!data) {
    throw new Error(
      'That isn\'t a valid Matter pairing code. Use the 11-digit code from the Home app\'s "Turn On Pairing Mode".',
    )
  }
  // Over the IP network only: the plug is already on Wi-Fi, or on Thread through Apple's border router.
  const nodeId = await controller.commissionNode(
    {
      commissioning: {
        regulatoryLocation: M.GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: 'XX',
      },
      discovery: {
        identifierData: data.identifier,
        discoveryCapabilities: { onIpNetwork: true },
        timeout: M.Seconds(60),
      },
      passcode: data.passcode,
    },
    { connectNodeAfterCommissioning: false },
  )
  return String(nodeId)
}

function allEndpoints(node) {
  const found = new Map()
  const visit = (ep) => {
    if (!ep || found.has(Number(ep.number))) {
      return
    }
    found.set(Number(ep.number), ep)
    ep.getChildEndpoints().forEach(visit)
  }
  visit(node.getRootEndpoint())
  node.getDevices().forEach(visit)
  // Endpoint 0 is the Root Node: bookkeeping only, never the device's own outlet or metering.
  found.delete(0)
  return [
    ...found.values(),
  ].sort((a, b) => Number(a.number) - Number(b.number))
}
function clusterOn(ep, id) {
  return ep.getAllClusterClients().find(c => Number(c.id) === id)
}
function attr(cluster, id) {
  return cluster && Object.values(cluster.attributes).find(a => Number(a.id) === id)
}

function hubReport(nodeId, endpoint, clusterId, attributeId, value) {
  const key = H.HUB_ATTRS[`${clusterId}:${attributeId}`]
  if (!key) {
    return
  }
  if (key === 'watts') {
    lastReport.set(`${nodeId}:${endpoint}`, Date.now())
  }
  const group = hubGroup.get(nodeId)?.get(endpoint)
  if (group == null) {
    return
  }
  const v = H.hubValue(key, value)
  if (v !== null) {
    send({
      ev: 'value',
      nodeId,
      endpoint: group,
      key,
      value: v,
    })
  }
}
function hubInit(nodeId, node) {
  const info = node.basicInformation || {}
  const seen = new Set()
  const local = (ep, c, a) => {
    try {
      return attr(clusterOn(ep, c), a)?.getLocal()
    } catch {
      return undefined
    }
  }
  const tree = (ep) => {
    const n = Number(ep.number)
    if (seen.has(n)) {
      return null
    }
    seen.add(n)
    return {
      number: n,
      clusters: ep.getAllClusterClients().map(c => Number(c.id)),
      types: (local(ep, 0x001D, 0) || []).map(t => Number(t.deviceType)),
      label: local(ep, H.BRIDGED_INFO, 5) || local(ep, H.BRIDGED_INFO, 3) || '',
      children: ep.getChildEndpoints().map(tree).filter(Boolean),
    }
  }
  const roots = [
    tree(node.getRootEndpoint()),
    ...node.getDevices().map(tree),
  ].filter(Boolean)
  const { groups, devices } = H.hubDevices(roots)
  hubGroup.set(nodeId, groups)
  log(
    'info',
    `Node ${nodeId}: ${devices.length} device${
      devices.length === 1
        ? ''
        : 's'
    } (${devices.map(d => `#${d.endpoint}[${d.clusters.map(c => `0x${c.toString(16)}`).join(',')}]`).join(' ')})`,
  )
  send({
    ev: 'info',
    nodeId,
    product: `${info.vendorName ?? ''} ${info.productName ?? ''}`.trim() || 'Matter device',
    devices,
  })
  for (const ep of allEndpoints(node)) {
    for (const c of ep.getAllClusterClients()) {
      for (const a of Object.values(c.attributes)) {
        if (H.HUB_ATTRS[`${Number(c.id)}:${Number(a.id)}`]) {
          try {
            hubReport(nodeId, Number(ep.number), Number(c.id), Number(a.id), a.getLocal())
          } catch {}
        }
      }
    }
  }
}

async function connect(nodeId) {
  if (nodes.has(nodeId)) {
    return
  }
  const node = await controller.getNode(M.NodeId(BigInt(nodeId)))
  nodes.set(nodeId, node)
  hubGroup.set(nodeId, new Map())
  node.events.attributeChanged.on(({ path, value }) =>
    hubReport(nodeId, Number(path.endpointId), Number(path.clusterId), Number(path.attributeId), value),
  )
  node.events.stateChanged.on(state => send({ ev: 'state', nodeId, state: M.NodeStates[state] ?? String(state) }))
  node.events.initializedFromRemote.on(() => hubInit(nodeId, node))
  node.events.structureChanged?.on?.(() => hubInit(nodeId, node)) // a device added to / removed from a hub
  node.connect()
}

// Ask power meters that have gone quiet for a fresh reading (some only report about once a minute)
let polling = false
async function pollQuiet() {
  if (polling) {
    return
  }
  polling = true
  try {
    for (const [nodeId, node] of nodes) {
      const grp = hubGroup.get(nodeId)
      if (!grp) {
        continue
      }
      for (const ep of allEndpoints(node)) {
        const n = Number(ep.number)
        if (!grp.has(n)) {
          continue
        }
        const a = attr(clusterOn(ep, ELECTRICAL_POWER_MEASUREMENT), ACTIVE_POWER)
        if (!a) {
          continue
        }
        const key = `${nodeId}:${n}`
        if (Date.now() - (lastReport.get(key) || 0) < POLL_IF_QUIET_MS) {
          continue
        }
        lastReport.set(key, Date.now())
        try {
          hubReport(nodeId, n, ELECTRICAL_POWER_MEASUREMENT, ACTIVE_POWER, await a.get(true))
        } catch (e) {
          log('debug', `Polling ${key} failed: ${e.message}`)
        }
      }
    }
  } finally {
    polling = false
  }
}

async function unpair(nodeId) {
  const node = nodes.get(nodeId)
  nodes.delete(nodeId)
  hubGroup.delete(nodeId)
  try {
    await controller.removeNode(M.NodeId(BigInt(nodeId)), true)
  } catch (e) {
    log(
      'warn',
      `Couldn't cleanly remove node ${nodeId} from the plug (${e.message}). You can remove "Shelly Appliances" (this plugin's controller) under the device's Connected Services in the Home app.`,
    )
    try {
      node?.disconnect?.()
    } catch {}
  }
}

process.on('message', async (m) => {
  try {
    if (m.cmd === 'pair') {
      try {
        send({ ev: 'paired', id: m.id, nodeId: await pair(m.id, m.code) })
      } catch (e) {
        send({ ev: 'pairFailed', id: m.id, error: e.message })
      }
    } else if (m.cmd === 'connect') {
      await connect(String(m.nodeId))
    } else if (m.cmd === 'unpair') {
      await unpair(String(m.nodeId))
    } else if (m.cmd === 'stop') {
      try {
        await controller?.close()
      } catch {}
      process.exit(0)
    }
  } catch (e) {
    log('error', `${m.cmd} failed: ${e.message}`)
  }
})
process.on('disconnect', () => process.exit(0))
process.on('unhandledRejection', e => log('error', e?.stack || e))
process.on('uncaughtException', (e) => {
  log('error', e?.stack || e)
})

boot().catch((e) => {
  const missing = /Cannot find (?:package|module)/.test(e.message)
  send({
    ev: 'fatal',
    error: missing
      ? 'matter.js is not installed alongside the plugin. Reinstall the plugin with internet access so npm can download its dependencies.'
      : e.message,
  })
  setTimeout(() => process.exit(1), 200)
})
