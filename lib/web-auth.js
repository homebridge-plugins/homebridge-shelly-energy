// The web page's PIN and sign-ins. The PIN is kept only as a scrypt hash; each signed-in browser holds a random key in a
// cookie, kept here only as its SHA-256. Nothing in settings.web is ever sent to a page or written to an export.
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const MAX_SESSIONS = 20
const SESSION_DAYS = 30 // a browser signs in again after 30 days
const scrypt = promisify(crypto.scrypt)
const fresh = x => Date.now() - (+x.at || 0) < SESSION_DAYS * 86400e3
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex')

export function cleanWeb(w) {
  w = w && typeof w === 'object'
    ? w
    : {}
  const pin
    = w.pin && /^[0-9a-f]{32}$/.test(w.pin.salt) && /^[0-9a-f]{128}$/.test(w.pin.hash)
      ? { salt: w.pin.salt, hash: w.pin.hash }
      : null
  const tokens = (Array.isArray(w.tokens)
    ? w.tokens
    : [])
    .filter(x => x && /^[0-9a-f]{64}$/.test(x.h) && fresh(x))
    .slice(-MAX_SESSIONS)
    .map(x => ({ h: x.h, at: +x.at || 0, seen: +x.seen || 0 }))
  // readOnly: a signed-in browser can look but change nothing (for phones and the rest of the family)
  return {
    on: w.on !== false,
    pin,
    tokens,
    readOnly: w.readOnly === true,
  }
}
function checkPinRules(pin) {
  pin = String(pin ?? '')
  if (pin.length < 6 || pin.length > 32) {
    throw new Error('The PIN needs 6 to 32 characters.')
  }
  if (
    /^(.)\1+$/.test(pin)
    || /^(?:0123456789|123456789|987654321|abcdef|qwerty|password)/i.test(pin)
    || [
      '123456',
      '654321',
      '1234567',
      '12345678',
      '123123',
      '112233',
    ].includes(pin)
  ) {
    throw new Error('Pick a PIN that isn\'t that easy to guess.')
  }
  return pin
}
export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex')
  return {
    salt,
    hash: crypto.scryptSync(checkPinRules(pin), salt, 64).toString('hex'),
  }
}
/** Whether a PIN is right. scrypt runs in the background, so checking a PIN never holds up the rest of the plugin. */
export async function pinOk(web, pin) {
  if (!web.pin || typeof pin !== 'string' || pin.length > 64) {
    return false
  }
  const a = await scrypt(pin, web.pin.salt, 64)
  const b = Buffer.from(web.pin.hash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
/** A new signed-in browser: returns the key for its cookie. */
export function newSession(web) {
  const raw = crypto.randomBytes(32).toString('hex')
  web.tokens.push({
    h: sha(raw),
    at: Date.now(),
    seen: Date.now(),
  })
  while (web.tokens.length > MAX_SESSIONS) web.tokens.shift()
  return raw
}
export function sessionOk(web, raw) {
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) {
    return null
  }
  const h = sha(raw)
  const t = web.tokens.find(x => x.h === h)
  if (t && !fresh(t)) {
    // as old as its cookie: a copied cookie must not work for ever
    web.tokens = web.tokens.filter(x => x !== t)
    return null
  }
  return t || null
}
export function endSession(web, raw) {
  const h = sha(raw || '')
  web.tokens = web.tokens.filter(x => x.h !== h)
}
/** What the settings page may see: never the hash or the keys. */
export function webPublic(web) {
  return {
    on: web.on,
    pinSet: !!web.pin,
    sessions: web.tokens.filter(fresh).length,
    readOnly: !!web.readOnly,
  }
}
export { SESSION_DAYS }
