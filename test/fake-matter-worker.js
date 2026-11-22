// Stand-in for lib/matter-controller.js (HE_MATTER_WORKER): no matter.js, no network. It "pairs" with any 11-digit code
// and reports made-up devices through the real lib/matter-hub.js mapping, so the GRILLPLATS rule is exercised:
//   code starting 1 -> node 42: a GRILLPLATS-shaped plug (ep1 OnOff + power, ep2 power only: the mirror, ignored)
//   code starting 2 -> node 43: an Eve Energy-shaped plug (one endpoint, OnOff + power)
//   code starting 3 -> node 44: a hub with a door sensor, a light (no power) and a temperature/humidity sensor
//   code starting 4 -> node 45: a plug with its relay on ep1 and its power meter on ep2 (how a real GRILLPLATS reports)
//   anything else 11 digits -> a pairing that fails like a wrong code
// Nodes "already paired" (as if from a copied controller folder) are read from <storage>/fake-nodes.json.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { hubDevices } from '../lib/matter-hub.js'

const send = m => process.send?.(m)
const dir = process.argv[2]
function fileNodes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'fake-nodes.json'), 'utf8'))
  } catch {
    return []
  }
}
const saveNodes = n => fs.writeFileSync(path.join(dir, 'fake-nodes.json'), JSON.stringify(n))
const TREES = {
  42: {
    product: 'IKEA of Sweden GRILLPLATS',
    tree: [
      {
        number: 1,
        clusters: [0x6, 0x90, 0x91],
        types: [0x10A],
        children: [],
      },
      {
        number: 2,
        clusters: [0x90, 0x91],
        types: [0x510],
        children: [],
      },
    ],
  },
  43: {
    product: 'Eve Systems Eve Energy',
    tree: [
      {
        number: 1,
        clusters: [0x6, 0x90],
        types: [0x10A],
        children: [],
      },
    ],
  },
  45: {
    product: 'IKEA of Sweden GRILLPLATS Plug',
    tree: [
      {
        number: 1,
        clusters: [0x6],
        types: [0x10A],
        children: [],
      },
      {
        number: 2,
        clusters: [0x90, 0x91],
        types: [0x510],
        children: [],
      },
    ],
  },
  44: {
    product: 'Aqara Hub M2',
    tree: [
      {
        number: 1,
        clusters: [0x1D],
        types: [0x0E],
        children: [
          {
            number: 2,
            clusters: [0x39, 0x45],
            types: [0x15],
            label: 'Front door',
            children: [],
          },
          {
            number: 3,
            clusters: [0x39, 0x6, 0x8],
            types: [0x101],
            label: 'Hall light',
            children: [],
          },
          {
            number: 4,
            clusters: [0x39, 0x402, 0x405],
            types: [0x302, 0x307],
            label: 'Hall climate',
            children: [],
          },
        ],
      },
    ],
  },
}
const timers = []
let watts = 0
const on = true
function connect(nodeId) {
  const T = TREES[nodeId]
  if (!T) {
    return send({ ev: 'state', nodeId, state: 'Disconnected' })
  }
  setTimeout(() => {
    send({ ev: 'state', nodeId, state: 'Connected' })
    send({
      ev: 'info',
      nodeId,
      product: T.product,
      devices: hubDevices(T.tree).devices,
    })
    if (nodeId === '42') {
      send({
        ev: 'value',
        nodeId,
        endpoint: 1,
        key: 'on',
        value: true,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 1,
        key: 'watts',
        value: 0,
      })
      timers.push(
        setInterval(
          () => {
            watts = watts ? 0 : 650
            send({
              ev: 'value',
              nodeId,
              endpoint: 1,
              key: 'watts',
              value: watts,
            })
          },
          +(process.env.HE_FAKE_GRILL_MS || 15000),
        ),
      )
    }
    if (nodeId === '43') {
      send({
        ev: 'value',
        nodeId,
        endpoint: 1,
        key: 'on',
        value: on,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 1,
        key: 'watts',
        value: 72.5,
      })
    }
    if (nodeId === '45') {
      send({
        ev: 'value',
        nodeId,
        endpoint: 1,
        key: 'on',
        value: true,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 2,
        key: 'watts',
        value: 27,
      })
    }
    if (nodeId === '44') {
      send({
        ev: 'value',
        nodeId,
        endpoint: 2,
        key: 'state',
        value: true,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 3,
        key: 'on',
        value: false,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 4,
        key: 'temp',
        value: 21.5,
      })
      send({
        ev: 'value',
        nodeId,
        endpoint: 4,
        key: 'hum',
        value: 55,
      })
    }
  }, 100)
}
process.on('message', (m) => {
  if (m.cmd === 'pair') {
    const c = String(m.code).replace(/[\s-]/g, '')
    setTimeout(() => {
      if (!/^\d{11}$/.test(c)) {
        return send({
          ev: 'pairFailed',
          id: m.id,
          error: 'That isn\'t a valid Matter pairing code. Use the 11-digit code from the Home app.',
        })
      }
      const node = { 1: '42', 2: '43', 3: '44', 4: '45' }[c[0]]
      if (!node) {
        return send({ ev: 'pairFailed', id: m.id, error: 'PASE failed: passcode rejected' })
      }
      saveNodes([
        ...new Set([
          ...fileNodes(),
          node,
        ]),
      ])
      send({ ev: 'paired', id: m.id, nodeId: node })
    }, 150)
  }
  if (m.cmd === 'connect') {
    connect(String(m.nodeId))
  }
  if (m.cmd === 'unpair') {
    saveNodes(fileNodes().filter(x => x !== String(m.nodeId)))
  }
  if (m.cmd === 'stop') {
    process.exit(0)
  }
})
process.on('disconnect', () => process.exit(0))
if (process.env.HE_FAKE_MATTER_CRASH === '1') {
  send({ ev: 'fatal', error: 'matter.js is not installed alongside the plugin.' })
  setTimeout(() => process.exit(1), 50)
} else {
  send({
    ev: 'ready',
    nodes: fileNodes(),
  })
}
