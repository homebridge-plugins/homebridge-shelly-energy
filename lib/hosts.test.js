// Device addresses: only home-network addresses, read the same way fetch reads them.
import assert from 'node:assert/strict'

import { it } from 'vitest'

import { hostList, isLanHost, lanHost } from './hosts.js'

it('refuses an address with a leading zero, which fetch would read as a different (internet) address', () => {
  // fetch reads 010 as octal 8: 010.8.8.8 is really 8.8.8.8
  for (const h of [
    '010.8.8.8',
    '172.016.0.1',
    '192.168.010.1',
    '010.0.0.1:80',
    '10.0.0.01',
  ]) {
    assert.equal(lanHost(h), '', h)
    assert.equal(isLanHost(h), false, h)
  }
  assert.deepEqual(hostList('010.8.8.8 192.168.1.10'), ['192.168.1.10'])
  // the plain forms still work
  for (const h of [
    '10.0.0.1',
    '192.168.1.10',
    '172.16.0.1:8080',
    '192.168.0.100',
  ]) {
    assert.equal(lanHost(h), h)
  }
})

it('every address it accepts is a home-network address once fetch has read it', () => {
  for (const h of [
    '10.0.0.1',
    '010.8.8.8',
    '0192.168.1.1',
    '127.1',
    '192.168.1.255',
    '172.31.255.255',
    'shelly.local',
    '[fd00::1]',
  ]) {
    const ok = lanHost(h)
    if (ok) {
      assert.ok(isLanHost(new URL(`http://${ok}/`).hostname), `${h} -> ${new URL(`http://${ok}/`).hostname}`)
    }
  }
})

it('refuses a number written in hex or as one whole number, which fetch reads as an internet address', () => {
  // fetch reads 0x08080808 and 134744072 as 8.8.8.8
  for (const h of [
    '0x08080808',
    '134744072',
    '0x8.0x8.0x8.0x8',
    '0x08080808:80',
  ]) {
    assert.equal(lanHost(h), '', h)
  }
  assert.deepEqual(hostList('0x08080808 shelly-em'), ['shelly-em'])
  // a plain one-word name, or a home-network address in the same forms, still works
  for (const h of [
    'shelly-em',
    'shelly-em:80',
    '0x0a000001',
  ]) {
    assert.equal(lanHost(h), h)
  }
})
