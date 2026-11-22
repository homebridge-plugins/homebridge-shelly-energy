// the settings page's server side (lib/homebridge-ui/handlers.js): only known actions pass, large files go
// in pieces both ways, and a plugin that isn't running is reported plainly.

import assert from 'node:assert/strict'
import os from 'node:os'

import { it } from 'vitest'

import { makeHandlers } from './handlers.js'

const calls = []
async function fake(dir, action, args) {
  calls.push([action, args])
  if (action === 'exportData') {
    return {
      big: 'x'.repeat(700 * 1024),
    }
  }
  if (action === 'importFile') {
    return {
      counts: { appliances: args.data.sigs.length },
    }
  }
  return { action }
}

it('only the page\'s actions are passed on', async () => {
  const H = makeHandlers('/tmp/x', fake)
  assert.deepEqual(await H['/call']({ action: 'view' }), {
    ok: true,
    result: { action: 'view' },
  })
  await assert.rejects(H['/call']({ action: 'exportData' }), /Unknown action/)
  await assert.rejects(H['/call']({ action: 'constructor' }), /Unknown action/)
})
it('a large export comes back in pieces, a large import goes in pieces', async () => {
  const H = makeHandlers('/tmp/x', fake)
  const s = await H['/export/start']()
  let text = ''
  for (let i = 0; i < s.n; i++) text += await H['/export/piece']({ id: s.id, i })
  assert.ok(s.n >= 3)
  assert.equal(JSON.parse(text).big.length, 700 * 1024)
  const body = JSON.stringify({
    sigs: [
      { id: 'a', name: 'A' },
    ],
    pad: 'y'.repeat(600 * 1024),
  })
  const u = await H['/upload/start']({ size: body.length, name: 'export.json' })
  for (let i = 0, k = 0; i < body.length; i += u.piece, k++) {
    await H['/upload/piece']({
      id: u.id,
      i: k,
      data: body.slice(i, i + u.piece),
    })
  }
  assert.deepEqual(await H['/upload/finish']({ id: u.id }), {
    ok: true,
    result: {
      counts: { appliances: 1 },
    },
  })
  await assert.rejects(H['/upload/finish']({ id: u.id }), /expired/)
  await assert.rejects(H['/upload/start']({ size: 500e6 }), /too large/)
  const bad = await H['/upload/start']({ size: 5 })
  await H['/upload/piece']({ id: bad.id, i: 0, data: 'nope!' })
  assert.match((await H['/upload/finish']({ id: bad.id })).error, /isn't JSON/)
})
it('a plugin that isn\'t running is reported plainly', async () => {
  const H = makeHandlers(`/tmp/definitely-not-here-${Date.now()}`)
  const r = await H['/call']({ action: 'view' })
  assert.equal(r.ok, false)
  assert.equal(r.notRunning, true)
  assert.match(r.error, /isn't running/)
})

it('an upload can\'t grow past the size it declared, and a file is at most 20 MB', async () => {
  const H = makeHandlers(os.tmpdir(), async () => ({}))
  const piece = (await H['/upload/start']({ size: 10 })).piece
  // a piece no bigger than the page sends, and never more in total than the declared size
  const u = await H['/upload/start']({ size: 10 })
  await assert.rejects(H['/upload/piece']({
    id: u.id,
    i: 0,
    data: 'x'.repeat(piece + 1),
  }), /Bad piece/)
  await H['/upload/piece']({ id: u.id, i: 0, data: '0123456789' })
  await assert.rejects(H['/upload/piece']({ id: u.id, i: 1, data: 'x' }), /larger than/)
  await assert.rejects(H['/upload/piece']({
    id: u.id,
    i: 900,
    data: 'x'.repeat(piece),
  }), /larger than/)
  // a two-year backup is about 3 MB
  await assert.rejects(H['/upload/start']({ size: 21 * 1024 * 1024 }), /too large/)
})

it('at most two uploads are kept at once: a third replaces the oldest', async () => {
  const H = makeHandlers(os.tmpdir(), async () => ({}))
  const a = await H['/upload/start']({ size: 5 })
  const b = await H['/upload/start']({ size: 5 })
  const c = await H['/upload/start']({ size: 5 })
  await assert.rejects(H['/upload/piece']({ id: a.id, i: 0, data: 'hello' }), /expired/)
  assert.equal(await H['/upload/piece']({ id: b.id, i: 0, data: 'hello' }), true)
  assert.equal(await H['/upload/piece']({ id: c.id, i: 0, data: 'hello' }), true)
})
