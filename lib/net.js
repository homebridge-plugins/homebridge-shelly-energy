// Reading a device on the home network: never follows a redirect (a device can't send the plugin elsewhere), gives up after a
// timeout, and stops reading a reply larger than any Shelly sends (a misbehaving device can't fill the plugin's memory).
const MAX_REPLY = 1024 * 1024

/** GET http://host/path -> { status, ok, json } (json: the parsed reply, or null if it wasn't JSON). Throws on no answer. */
export async function getDevice(fetchImpl, host, path, { timeout = 3000, max = MAX_REPLY } = {}) {
  const r = await fetchImpl(`http://${host}/${path}`, {
    signal: AbortSignal.timeout(timeout),
    cache: 'no-store',
    redirect: 'manual',
  })
  let text = ''
  if (r.body?.getReader) {
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.length
      if (size > max) {
        try {
          await reader.cancel()
        } catch {}
        throw new Error('The device sent far more than expected.')
      }
      text += dec.decode(value, { stream: true })
    }
    text += dec.decode()
  } else {
    text = String(await r.text()).slice(0, max)
  }
  let json = null
  try {
    json = text
      ? JSON.parse(text)
      : null
  } catch {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json }
}
