// Find Shellys: which addresses are asked, and what each kind of Shelly looks like when found.

import assert from 'node:assert/strict'

import { it } from 'vitest'

import { startFakeEm, startFakeGen1, startFakeGen2, startFakeShelly } from '../test/fake-shelly.js'
import { findShellys, scanTargets } from './discover.js'

async function nobody() {
  throw new Error('ENOTFOUND')
}

it('asks only this computer\'s home network: not itself, not the internet, capped on big networks', () => {
  const t = scanTargets({
    en0: [
      {
        family: 'IPv4',
        address: '192.168.1.50',
        netmask: '255.255.255.0',
        internal: false,
      },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    lo0: [
      {
        family: 'IPv4',
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        internal: true,
      },
    ],
    utun: [
      {
        family: 'IPv4',
        address: '100.64.0.2',
        netmask: '255.192.0.0',
        internal: false,
      },
    ],
  })
  assert.deepEqual(t.networks, ['192.168.1.0/24'])
  assert.equal(t.hosts.length, 253)
  assert.ok(!t.hosts.includes('192.168.1.50') && !t.hosts.includes('192.168.1.0') && !t.hosts.includes('192.168.1.255'))
  const big = scanTargets({
    en0: [
      {
        family: 'IPv4',
        address: '10.1.2.3',
        netmask: '255.0.0.0',
        internal: false,
      },
    ],
  })
  assert.deepEqual(big.networks, ['10.1.2.0/24'], 'a /8 is scanned as the /24 around this computer')
  const two = scanTargets({
    en0: [
      {
        family: 'IPv4',
        address: '192.168.1.50',
        netmask: '255.255.252.0',
        internal: false,
      },
    ],
    en1: [
      {
        family: 'IPv4',
        address: '192.168.1.51',
        netmask: '255.255.252.0',
        internal: false,
      },
    ],
  })
  assert.equal(two.networks.length, 1)
  assert.equal(
    two.hosts.length,
    1020,
    'same network on Ethernet and Wi-Fi: asked once, neither of this computer\'s addresses',
  )
  assert.equal(
    scanTargets({
      en0: [
        {
          family: 'IPv4',
          address: '169.254.3.4',
          netmask: '255.255.0.0',
          internal: false,
        },
      ],
    }).hosts.length,
    0,
    'no self-assigned network',
  )
})

it(
  'finds every kind: Gen2+ with what it measures, Gen1 with its name, the HomeKit firmware; a password is reported; others ignored',
  async () => {
    const servers = [
      startFakeGen2(18911, { name: 'Dryer', id: 'shellyplusplugs-aa11' }),
      startFakeGen1(18912, { type: 'SHSW-PM', name: 'Heater relay' }),
      startFakeShelly(18913, { name: 'Garage light' }),
      startFakeGen2(18914, { password: true, id: 'shellyplus1-locked' }),
      startFakeEm(18915),
    ]
    try {
      const hosts = [
        18911,
        18912,
        18913,
        18914,
        18915,
        18916,
      ].map(p => `127.0.0.1:${p}`)
      const r = await findShellys({
        targets: {
          networks: ['test'],
          hosts,
        },
        lookup: nobody,
      })
      const by = Object.fromEntries(r.found.map(s => [s.ip, s]))
      assert.equal(r.scanned, 6)
      assert.equal(r.found.length, 4, JSON.stringify(r.found.map(s => s.ip)))
      const g2 = by['127.0.0.1:18911']
      assert.equal(g2.kind, 'rpc')
      assert.equal(g2.measures, true)
      assert.equal(g2.channels, 1)
      assert.equal(g2.host, g2.ip, 'no .local name: the address')
      const g1 = by['127.0.0.1:18912']
      assert.equal(g1.kind, 'gen1')
      assert.equal(g1.name, 'Heater relay')
      assert.equal(g1.model, 'SHSW-PM')
      const hk = by['127.0.0.1:18913']
      assert.equal(hk.kind, 'homekit')
      assert.ok(hk.channels >= 1)
      const locked = by['127.0.0.1:18914']
      assert.equal(locked.password, true)
      assert.equal(locked.channels, 0)
      assert.ok(!by['127.0.0.1:18915'], 'a server that isn\'t a Shelly is left out')
      assert.ok(r.found.every(s => !('hostname' in s)))
    } finally {
      for (const s of servers) s.close()
    }
  },
)

it('a .local name is offered only when it leads back to the same address', async () => {
  const g = startFakeGen2(18921, { id: 'shellyplusplugs-bb22' })
  try {
    const hosts = ['127.0.0.1:18921']
    let r = await findShellys({
      targets: { networks: [], hosts },
      lookup: async name => ({
        address: name === 'shellyplusplugs-bb22.local'
          ? '127.0.0.1'
          : '0.0.0.0',
      }),
    })
    assert.equal(r.found[0].host, 'shellyplusplugs-bb22.local:18921')
    r = await findShellys({
      targets: { networks: [], hosts },
      lookup: async () => ({ address: '127.0.0.9' }),
    })
    assert.equal(r.found[0].host, '127.0.0.1:18921', 'the name points elsewhere: keep the address')
    r = await findShellys({
      targets: { networks: [], hosts },
      lookup: () => new Promise(() => {}),
      nameTimeout: 200,
    })
    assert.equal(r.found[0].host, '127.0.0.1:18921', 'the name never resolves: keep the address')
  } finally {
    g.close()
  }
})

it('internet addresses are never asked, even if handed in', async () => {
  const asked = []
  await findShellys({
    targets: {
      networks: [],
      hosts: ['8.8.8.8', '1.1.1.1', '192.168.1.77'],
    },
    fetchImpl: async (url) => {
      asked.push(url)
      throw new Error('no')
    },
    lookup: nobody,
  })
  assert.deepEqual(asked, ['http://192.168.1.77/shelly'])
})
