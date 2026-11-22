// node test/ui-unit.mjs - the settings page's server side (lib/homebridge-ui/handlers.js): only known actions pass, large files go
// in pieces both ways, and a plugin that isn't running is reported plainly.
import assert from 'node:assert/strict';
import { makeHandlers } from '../lib/homebridge-ui/handlers.js';

let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const calls = [];
const fake = async (dir, action, args) => { calls.push([action, args]); if (action === 'exportData') return { big: 'x'.repeat(700 * 1024) }; if (action === 'importFile') return { counts: { appliances: args.data.sigs.length } }; return { action }; };

await ok('only the page\'s actions are passed on', async () => {
  const H = makeHandlers('/tmp/x', fake);
  assert.deepEqual(await H['/call']({ action: 'view' }), { ok: true, result: { action: 'view' } });
  await assert.rejects(H['/call']({ action: 'exportData' }), /Unknown action/);
  await assert.rejects(H['/call']({ action: 'constructor' }), /Unknown action/);
});
await ok('a large export comes back in pieces, a large import goes in pieces', async () => {
  const H = makeHandlers('/tmp/x', fake);
  const s = await H['/export/start']();
  let text = ''; for (let i = 0; i < s.n; i++) text += await H['/export/piece']({ id: s.id, i });
  assert.ok(s.n >= 3); assert.equal(JSON.parse(text).big.length, 700 * 1024);
  const body = JSON.stringify({ sigs: [{ id: 'a', name: 'A' }], pad: 'y'.repeat(600 * 1024) });
  const u = await H['/upload/start']({ size: body.length, name: 'export.json' });
  for (let i = 0, k = 0; i < body.length; i += u.piece, k++) await H['/upload/piece']({ id: u.id, i: k, data: body.slice(i, i + u.piece) });
  assert.deepEqual(await H['/upload/finish']({ id: u.id }), { ok: true, result: { counts: { appliances: 1 } } });
  await assert.rejects(H['/upload/finish']({ id: u.id }), /expired/);
  await assert.rejects(H['/upload/start']({ size: 500e6 }), /too large/);
  const bad = await H['/upload/start']({ size: 5 }); await H['/upload/piece']({ id: bad.id, i: 0, data: 'nope!' });
  assert.match((await H['/upload/finish']({ id: bad.id })).error, /isn't JSON/);
});
await ok('a plugin that isn\'t running is reported plainly', async () => {
  const H = makeHandlers('/tmp/definitely-not-here-' + Date.now());
  const r = await H['/call']({ action: 'view' });
  assert.equal(r.ok, false); assert.equal(r.notRunning, true); assert.match(r.error, /isn't running/);
});
console.log(`${n} passed`);
