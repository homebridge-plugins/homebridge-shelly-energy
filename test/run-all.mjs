// node test/run-all.mjs - every unit test plus the start-up test. The browser test is separate (see test/README.md).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = 0
for (const [file, ...args] of [
  ['engine-unit.mjs'],
  ['shelly-unit.mjs'],
  ['discover-unit.mjs'],
  ['cycles-unit.mjs'],
  ['matter-unit.mjs'],
  ['tiles-unit.mjs'],
  ['import-unit.mjs'],
  ['insights-unit.mjs'],
  ['ui-unit.mjs'],
  ['web-unit.mjs'],
  ['boot.mjs', '10'],
]) {
  const r = spawnSync(process.execPath, [
    path.join(here, file),
    ...args,
  ], { encoding: 'utf8', timeout: 180000 })
  const last = (r.stdout || '').trim().split('\n').pop()
  console.log(`${r.status === 0
    ? 'PASS'
    : 'FAIL'}  ${file.padEnd(18)} ${last}`)
  if (r.status !== 0) {
    failed++
    console.log((r.stdout || '').slice(-1500), (r.stderr || '').slice(-1500))
  }
}
console.log(failed
  ? `${failed} failed`
  : 'all passed')
process.exit(failed ? 1 : 0)
