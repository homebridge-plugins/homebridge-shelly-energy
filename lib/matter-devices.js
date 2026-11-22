// Starts the Matter controller helper (lib/matter-controller.js) as a separate process and feeds what it reports into the
// engine. Started only once at least one Matter device has been added. One path for all devices.

import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PAIR_TIMEOUT = 3 * 60e3
// the tests' stand-in helper (HE_MATTER_WORKER) is used only if it's inside this plugin's own folder; otherwise the real one
function defaultWorker() {
  const w = process.env.HE_MATTER_WORKER && path.resolve(process.env.HE_MATTER_WORKER)
  return w && w.startsWith(ROOT + path.sep) && fs.existsSync(w)
    ? w
    : path.join(HERE, 'matter-controller.js')
}

export class MatterDevices {
  constructor({ engine, log, storageDir, logLevel = 'warn', worker = defaultWorker() }) {
    this.engine = engine
    this.log = log
    this.dir = storageDir
    this.logLevel = logLevel
    this.worker = worker
    this.child = null
    this.ready = false
    this.pending = []
    this.restarts = 0
    this.stopped = false
    this.fatal = null
    this.pairTimers = new Map()
  }

  get running() {
    return !!this.child
  }

  start() {
    if (this.child || this.stopped || this.fatal) {
      return
    }
    fs.mkdirSync(this.dir, { recursive: true })
    this.log.info('Starting the Matter controller for your Matter devices…')
    const child = fork(this.worker, [this.dir, this.logLevel], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
    this.child = child
    child.stdout.on('data', d => this.log.debug(`[Matter] ${String(d).trim()}`))
    child.stderr.on('data', d => this.log.debug(`[Matter] ${String(d).trim()}`))
    child.on('message', (m) => {
      try {
        this.onMessage(m)
      } catch (e) {
        this.log.error(`Matter message failed: ${e.message}`)
      }
    })
    child.on('error', e => this.log.warn(`Matter controller: ${e.message}`))
    child.on('exit', (code) => {
      this.child = null
      this.ready = false
      if (this.stopped || this.fatal) {
        return
      }
      for (const m of this.engine.matterDevices) {
        if (m.status === 'connected') {
          m.status = 'reconnecting'
        }
      }
      this.engine.changed()
      this.engine.matterPublish()
      const wait = Math.min(60e3, 5e3 * 2 ** this.restarts++)
      this.log.warn(`The Matter controller stopped (code ${code}); restarting in ${Math.round(wait / 1000)} s.`)
      this.restartTimer = setTimeout(() => this.start(), wait)
    })
  }

  send(m) {
    if (this.ready && this.child) {
      this.child.send(m)
    } else {
      this.pending.push(m)
    }
    this.start()
  }

  onMessage(m) {
    const e = this.engine
    switch (m.ev) {
      case 'ready': {
        this.ready = true
        this.restarts = 0
        e.matterSystem = { ok: true, error: null }
        this.known = new Set((m.nodes || []).map(String))
        this.asked = new Set()
        this.connectAll()
        const q = this.pending
        this.pending = []
        q.forEach(x => this.child.send(x))
        e.changed()
        break
      }
      case 'paired': {
        clearTimeout(this.pairTimers.get(m.id))
        this.pairTimers.delete(m.id)
        e.matterPaired(m.id, m.nodeId)
        this.known?.add(String(m.nodeId))
        this.asked?.add(String(m.nodeId))
        this.log.info(`Paired the Matter device "${e.matterById(m.id)?.name}" as node ${m.nodeId}. Connecting…`)
        this.child?.send({
          cmd: 'connect',
          nodeId: String(m.nodeId),
        })
        e.save()
        break
      }
      case 'pairFailed':
        clearTimeout(this.pairTimers.get(m.id))
        this.pairTimers.delete(m.id)
        e.matterFailed(m.id, friendly(m.error))
        this.log.warn(`Pairing a Matter device failed: ${m.error}`)
        break
      case 'state':
        e.matterStatus(m.nodeId, m.state)
        break
      case 'info': {
        e.matterInfo(m.nodeId, m.product, m.devices || [])
        const d = e.matterByNode(m.nodeId)
        const metered = (m.devices || []).filter(x => (x.clusters || []).includes(0x0090)).length
        this.log.info(
          `Matter device "${d?.name}" connected (${m.product}): ${(m.devices || []).length} part${
            (m.devices || []).length === 1
              ? ''
              : 's'
          }, ${metered} with power readings.`,
        )
        break
      }
      case 'value':
        e.matterValue(m.nodeId, m.endpoint, m.key, m.value)
        break
      case 'log':
        ;(this.log[m.level] || this.log.debug).call(this.log, `[Matter] ${m.msg}`)
        break
      case 'fatal':
        this.fatal = m.error
        e.matterSystem = { ok: false, error: m.error }
        this.log.error(`Matter devices could not be read: ${m.error}`)
        e.changed()
        break
    }
  }

  // connect every device with a pairing the controller knows (once per controller start); one it doesn't know needs a new code
  connectAll() {
    if (!this.ready || !this.child) {
      if (this.engine.matterDevices.some(d => d.nodeId)) {
        this.start()
      }
      return
    }
    for (const d of this.engine.matterDevices) {
      if (!d.nodeId || this.asked.has(d.nodeId)) {
        continue
      }
      if (this.known.has(d.nodeId)) {
        this.asked.add(d.nodeId)
        d.status = 'connecting'
        this.child.send({ cmd: 'connect', nodeId: d.nodeId })
      } else {
        d.status = 'failed'
        d.error
          = 'This device is no longer paired with the plugin. Remove it and add it again with a new code from the Home app.'
      }
    }
    this.engine.changed()
  }

  pair(id, code) {
    this.engine.matterPairing(id)
    this.send({
      cmd: 'pair',
      id,
      code: String(code || '').slice(0, 40),
    })
    clearTimeout(this.pairTimers.get(id))
    this.pairTimers.set(
      id,
      setTimeout(() => {
        const d = this.engine.matterById(id)
        if (d?.status === 'pairing') {
          this.engine.matterFailed(id, friendly('timed out'))
        }
      }, PAIR_TIMEOUT),
    )
  }

  unpair(nodeId) {
    if (nodeId) {
      this.send({
        cmd: 'unpair',
        nodeId: String(nodeId),
      })
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.restartTimer)
    for (const t of this.pairTimers.values()) clearTimeout(t)
    const c = this.child
    if (!c) {
      return
    }
    try {
      c.send({ cmd: 'stop' })
    } catch {}
    setTimeout(() => {
      try {
        c.kill()
      } catch {}
    }, 3000).unref?.()
  }
}

function friendly(err) {
  const e = String(err || '')
  if (/valid Matter pairing code/i.test(e)) {
    return e
  }
  if (/timed? ?out|discover|not found|no device/i.test(e)) {
    return 'Couldn\'t find the device on the network. Get a new code in the Home app (they last 15 minutes) and check the device is online. Thread devices also need your HomePod or Apple TV, with this computer on the same network.'
  }
  if (/pase|passcode|spake|commission/i.test(e)) {
    return 'The device refused the code. Turn on pairing mode again in the Home app and use the new code.'
  }
  return e || 'Pairing failed.'
}
