// the settings page's browser script (public/app.js). It runs in a browser, so these tests read its source and
// run single helpers from it, each given the few things it uses.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { it } from 'vitest'

const src = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8').split('\n')

// one `const name = ...` from the top level of the script: its first line, up to the next statement at that level
function helper(name) {
  const start = src.findIndex(l => l.startsWith(`  const ${name} =`))
  assert.ok(start >= 0, `app.js has no ${name}`)
  let end = start + 1
  while (end < src.length && !/^ {2}[a-z/]/i.test(src[end])) {
    end++
  }
  return src.slice(start, end).join('\n')
}

function load(names, given) {
  const keys = Object.keys(given)
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `${names.map(helper).join('\n')}\nreturn { ${names.join(', ')} }`)(...keys.map(k => given[k]))
}

const BAD = 'a"><img src=x onerror=alert(1)>'

it('the room picker escapes a device\'s id', () => {
  const { roomPicker } = load(['esc', 'roomPicker'], {
    V: {
      settings: {
        rooms: ['Hall'],
      },
    },
    roomSort: (a, b) => a.localeCompare(b),
  })
  const html = roomPicker(`dv-${BAD}`, '')
  assert.ok(!html.includes('<img'), html)
  assert.ok(html.startsWith('<div data-roompick="dv-a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">'), html)
})

it('a room picker is found by its id, quotes and all', () => {
  const seen = []
  const { roomOf } = load(['roomOf'], {
    $: (s) => {
      seen.push(s)
      return null
    },
    CSS: {
      escape: s => s.replace(/["\\]/g, '\\$&'),
    },
  })
  assert.equal(roomOf(`dv-${BAD}`), undefined)
  assert.deepEqual(seen, ['[data-roompick="dv-a\\"><img src=x onerror=alert(1)>"]'])
})
