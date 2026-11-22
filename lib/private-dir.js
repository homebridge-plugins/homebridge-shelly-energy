// A folder of household data: made, or put right, so only the account Homebridge runs as can open it. Its files are written
// owner-only too, but some are written by other code (matter.js keeps the controller's Matter credentials in its folder), and
// a folder others can't open protects every file in it. Not on Windows, where folders take no such modes.
import fs from 'node:fs'
import process from 'node:process'

export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    return dir
  }
  try {
    if ((fs.statSync(dir).mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700)
    }
  } catch {
    /* not ours to change: leave it */
  }
  return dir
}
