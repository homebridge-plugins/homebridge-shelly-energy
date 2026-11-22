// The link between the plugin and its settings page: a socket file only this user can open, plus a random key.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { it } from 'vitest'

import { callPlugin, startControl } from './control.js'

const quiet = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}
async function until(fn) {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20))
}

it('with a long storage path, the socket goes in a private folder of its own, not the shared temp folder', async () => {
  if (process.platform === 'win32') {
    return
  }
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-ctl-')), 'a'.repeat(60), 'b'.repeat(40), 'home-energy')
  fs.mkdirSync(dataDir, { recursive: true })
  const c = startControl({
    dataDir,
    actions: {
      view: () => 'hello',
    },
    log: quiet,
  })
  await until(() => fs.existsSync(path.join(dataDir, 'control.json')))
  try {
    const dir = path.dirname(c.sock)
    // the shared temp folder (/tmp on Linux) lets anyone take a name there first
    assert.notEqual(dir, os.tmpdir())
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(await callPlugin(dataDir, 'view'), 'hello')
  } finally {
    c.close()
  }
  assert.ok(!fs.existsSync(path.dirname(c.sock)), 'its folder is removed on shutdown')
})

it('with a short storage path, the socket sits next to the plugin\'s data', async () => {
  if (process.platform === 'win32') {
    return
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-ctl-'))
  const c = startControl({
    dataDir,
    actions: {
      view: () => 'hi',
    },
    log: quiet,
  })
  await until(() => fs.existsSync(path.join(dataDir, 'control.json')))
  try {
    assert.equal(c.sock, path.join(dataDir, 'control.sock'))
    assert.equal(await callPlugin(dataDir, 'view'), 'hi')
  } finally {
    c.close()
  }
})

it('only runs the plugin\'s own actions, not names every JavaScript object has', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-ctl-'))
  const c = startControl({
    dataDir,
    actions: {
      view: () => 'hi',
    },
    log: quiet,
  })
  await until(() => fs.existsSync(path.join(dataDir, 'control.json')))
  try {
    for (const action of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
    ]) {
      await assert.rejects(callPlugin(dataDir, action, { x: 1 }), /Unknown action/, action)
    }
  } finally {
    c.close()
  }
})
