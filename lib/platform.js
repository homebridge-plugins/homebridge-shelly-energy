// The platform: learns your appliances from a Shelly EM whole-house meter, reads Shellys and Matter devices on your home
// network for exact figures, and shows each appliance in Apple Home as a Matter outlet with live watts and energy. Settings
// are on the plugin's own page in the Homebridge UI. Nothing leaves your home network.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { DISPLAY, PLATFORM_NAME, PLUGIN_NAME } from './constants.js'
import { startControl } from './control.js'
import { findShellys, scanTargets } from './discover.js'
import { ICONS } from './engine-util.js'
import { Engine } from './engine.js'
import { HapTiles } from './hap-tiles.js'
import { lanHost } from './hosts.js'
import { importBackup, listBackups, readBackup, saveBackup } from './import.js'
import { MatterDevices } from './matter-devices.js'
import { MatterTiles } from './matter-tiles.js'
import { ShellyDevices } from './shelly-devices.js'
import { EmPoller } from './shelly-em.js'
import { hashPin, webPublic } from './web-auth.js'
import { startWeb } from './web.js'

const VERSION = createRequire(import.meta.url)('../package.json').version

export class ShellyHomeEnergyPlatform {
  constructor(log, config, api) {
    this.log = log
    this.api = api
    this.config = config || {}
    this.timers = []
    this.storage = api.user.storagePath()
    this.dir = path.join(this.storage, 'home-energy')
    fs.mkdirSync(this.dir, { recursive: true })
    checkBridgeConfig(api, log)

    const e = (this.engine = new Engine({
      file: path.join(this.dir, 'state.json'),
      log,
      defaults: {
        threshold: this.config.threshold ?? 40,
        em: {
          host: lanHost(this.config.host),
          channel: this.config.channel || 'auto',
        },
      },
    }))
    if (this.config.host && !lanHost(this.config.host)) {
      log.warn(
        'The Shelly EM address in config.json isn\'t on your home network, so it isn\'t used. Set it on the plugin\'s settings page.',
      )
    }
    if (!e.settings.em.host) {
      log.warn('No Shelly EM address yet: set it on this plugin\'s settings page in the Homebridge UI.')
    }

    const mcDir = path.join(this.dir, 'matter-controller')
    this.matterDevices = new MatterDevices({
      engine: e,
      log,
      storageDir: mcDir,
      logLevel: this.config.matterLogLevel || 'warn',
    })
    this.em = new EmPoller({
      log,
      onSample: (t, p) => e.processSample(t, p),
      onStatus: (s) => {
        this.emStatus = s
      },
    })
    this.emStatus = this.em.status
    // the clamp(s) used as the whole-house meter aren't offered as devices too (that would count them twice)
    this.shelly = new ShellyDevices({
      log,
      hosts: e.settings.shellyHosts,
      onChange: () => this.shelly && e.setSource('shelly', this.shelly.list()),
      isMain: (host, key) => host === e.settings.em.host && (this.em.keys || []).includes(key),
    })
    this.hap = new HapTiles({
      api,
      log,
      engine: e,
      pluginName: PLUGIN_NAME,
      platformName: PLATFORM_NAME,
      manufacturer: DISPLAY,
    })

    e.on('em', () => this.em.set(e.settings.em.host, e.settings.em.channel))
    e.on('shellyHosts', () => this.shelly.setHosts(e.settings.shellyHosts))
    e.on('finished', (s, dur) =>
      log.info(
        `${s.name} finished (ran ${
          dur >= 3600
            ? `${(dur / 3600).toFixed(1)} h`
            : `${Math.max(1, Math.round(dur / 60))} min`
        }).`,
      ))
    e.on('learned', (s, what) => log.info(`${s.name}: learned ${what}.`))
    e.on('anomaly', (s, dur, base) =>
      log.warn(
        `${s.name} ran for ${Math.round(dur / 60)} min, against its usual ${Math.round(base / 60)} min. Worth a look.`,
      ))
    e.on('event', (ev, s) => {
      log.debug(`${ev.dir === 'on'
        ? '▲'
        : '▼'} ${Math.abs(ev.d)} W ${s
        ? s.name
        : ev.sig ? '(measured)' : 'unnamed'}`)
      if (this.started) {
        this.hap.pushAll()
      }
    })
    e.on('changed', () => {
      if (this.started) {
        this.hap.pushAll()
      }
    })
    const tiles = () => {
      if (!this.started) {
        return
      }
      this.matter?.sync()
      this.hap.sync()
    }
    e.on('sigs', tiles)
    e.on('tiles', tiles)

    api.on('didFinishLaunching', () => this.start().catch(err => log.error(`Starting failed: ${err.stack || err}`)))
    api.on('shutdown', () => this.stop())
  }

  // Homebridge hands back its cached HomeKit (HAP) tiles here, before didFinishLaunching
  configureAccessory(acc) {
    this.hap.configureAccessory(acc)
  }

  async start() {
    const api = this.api
    const e = this.engine
    const matterOn = typeof api.isMatterEnabled === 'function'
      ? api.isMatterEnabled()
      : !!api.matter
    if (matterOn && api.matter) {
      this.matter = new MatterTiles({
        api,
        log: this.log,
        engine: e,
        pluginName: PLUGIN_NAME,
        platformName: PLATFORM_NAME,
        manufacturer: DISPLAY,
      })
      await this.matter.sync()
      this.timers.push(setInterval(() => this.matter.pushAll(), 5000))
    } else {
      this.log.warn(
        'Matter is off for this plugin\'s child bridge, so appliances won\'t appear in Apple Home. Turn on Matter in the plugin\'s Bridge Settings (Homebridge 2.4 or newer) and restart.',
      )
    }
    this.started = true
    this.hap.sync()
    this.timers.push(setInterval(() => this.hap.pushAll(), 30000)) // countdowns and "Cheap Power Now" change without an event
    if (e.matterDevices.length) {
      this.matterDevices.start()
    }
    this.em.set(e.settings.em.host, e.settings.em.channel)
    this.em.start()
    this.shelly.start()
    // settings, appliances and tiles save within 30 s; readings (every second) every 5 minutes
    this.timers.push(
      setInterval(() => {
        if (e.dirty || (e.dataDirty && Date.now() - e.savedAt > 5 * 60e3)) {
          e.save()
        }
      }, 30000),
    )
    this.control = startControl({
      dataDir: this.dir,
      actions: this.actions(),
      log: this.log,
    })
    this.webPort
      = Number.isInteger(+this.config.webPort) && +this.config.webPort >= 0 && +this.config.webPort <= 65535
        ? +this.config.webPort
        : 8591
    this.startWeb()
    this.log.info(
      `${DISPLAY} ${VERSION}: ${e.sigs.length} appliance${
        e.sigs.length === 1
          ? ''
          : 's'
      }, ${e.settings.shellyHosts.length} Shelly address${
        e.settings.shellyHosts.length === 1
          ? ''
          : 'es'
      }, ${e.matterDevices.length} Matter device${e.matterDevices.length === 1
        ? ''
        : 's'}.`,
    )
  }

  // the web page on the home network (lib/web.js): on unless switched off on the settings page; webPort 0 in config.json = never
  startWeb() {
    if (this.web || !this.webPort || !this.engine.settings.web.on) {
      return
    }
    this.web = startWeb({
      port: this.webPort,
      engine: this.engine,
      actions: this.actions(),
      storagePath: this.storage,
      log: this.log,
      onSaveNeeded: () => {
        this.engine.dirty = true
      },
    })
  }

  stopWeb() {
    this.web?.close()
    this.web = null
  }

  webInfo() {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal && lanHost(a.address))
      .map(a => a.address)
    return {
      ...webPublic(this.engine.settings.web),
      port: this.webPort,
      running: !!this.web,
      urls: this.webPort
        ? ips.map(ip => `http://${ip}:${this.webPort}/`)
        : [],
    }
  }

  stop() {
    this.timers.forEach(clearInterval)
    this.stopWeb()
    this.em.stop()
    this.shelly.stop()
    this.matterDevices.stop()
    this.control?.close()
    this.engine.save()
  }

  // what the settings page can do (lib/control.js passes each request here)
  actions() {
    const e = this.engine
    const user = m => Object.assign(new Error(m), { user: true })
    const tilesSummary = () => ({
      matterOn: !!this.matter,
      hapOn: this.hap.hapOn,
      outlets: this.matter?.registered.size ?? 0,
    })
    return {
      view: () => ({
        ...e.view(),
        plugin: {
          version: VERSION,
          name: DISPLAY,
          started: !!this.started,
          icons: ICONS,
        },
        em: this.emStatus,
        shelly: this.shelly.status(),
        tiles: tilesSummary(),
        backups: listBackups(this.dir),
        web: this.webInfo(),
      }),
      // the web page's PIN and switch: the settings page in the Homebridge UI only (lib/web.js never passes these on)
      webSetPin: ({ pin }) => {
        e.settings.web.pin = hashPin(pin)
        e.settings.web.tokens = []
        e.changed()
        e.save()
        this.log.info('Web page: a new PIN was set; every browser has to sign in again.')
        return true
      },
      webSignOutAll: () => {
        e.settings.web.tokens = []
        e.changed()
        e.save()
        return true
      },
      webSet: ({ on }) => {
        e.settings.web.on = on === true
        e.changed()
        if (on === true) {
          this.startWeb()
        } else {
          this.stopWeb()
        }
        return true
      },
      summary: ({ days }) => e.summary(days),
      setSettings: (args) => {
        e.setSettings(args)
        return true
      },
      editSig: ({ id, ...o }) => {
        e.editSig(id, o)
        return true
      },
      forgetSig: ({ id }) => {
        e.forgetSig(id)
        return true
      },
      nameCluster: ({ key, name, icon, room }) => e.nameCluster(key, name, icon, { room }).id,
      dismiss: ({ name, w }) => {
        e.dismissSuggestion(name, w)
        return true
      },
      track: ({ devId, watts, sigId }) => e.track(devId, watts, sigId || null).id,
      keepSteps: ({ id }) => {
        e.keepSteps(id)
        return true
      },
      forgetLearned: ({ id }) => {
        e.forgetLearned(id)
        return true
      },
      nameCycle: ({ id, prog, name }) => {
        e.nameCycle(id, prog, name)
        return true
      },
      forgetCycle: ({ id, prog }) => {
        e.forgetCycle(id, prog)
        return true
      },
      hideDevice: ({ id, hide }) => {
        e.hideDevice(id, hide !== false)
        return true
      },
      dismissTip: ({ key }) => {
        e.dismissTip(key || null)
        return true
      },
      dismissAnomaly: ({ id }) => {
        e.dismissAnomaly(id || null)
        return true
      },
      untrack: ({ id }) => {
        e.untrack(id)
        return true
      },
      estWatts: ({ id, watts }) => {
        e.setEstWatts(id, watts)
        return true
      },
      estReset: ({ devId }) => {
        e.estReset(devId)
        return true
      },
      matterAdd: ({ name, code }) => {
        if (!/^(?:MT:[0-9A-Z.\-]+|[\d\s-]{11,30})$/i.test(String(code || '').trim())) {
          throw user('Enter the pairing code from the Home app: 11 digits (dashes are fine).')
        }
        const m = e.addMatter({ name })
        this.matterDevices.pair(m.id, code)
        return m.id
      },
      matterRetry: ({ id, code }) => {
        if (!e.matterById(id)) {
          throw user('Unknown Matter device')
        }
        this.matterDevices.pair(id, code)
        return true
      },
      matterRemove: ({ id }) => {
        const m = e.removeMatter(id)
        if (!m) {
          throw user('Unknown Matter device')
        }
        if (m.nodeId) {
          this.matterDevices.unpair(m.nodeId)
        }
        for (const s of e.sigs.filter(s => s.devId?.startsWith(`mhub:${m.nodeId}:`))) e.untrack(s.id)
        return true
      },
      // Find Shellys (Settings → Shellys and Matter devices): one scan at a time; a second request waits for the same answer
      shellyFind: () =>
        (this.finding ??= this.findShellys().finally(() => {
          this.finding = null
        })),
      importBackup: ({ name }) => {
        const r = importBackup(e, readBackup(this.dir, name), {
          from: `the backup of ${String(name).replace(/^shelly-home-energy-|\.json$/g, '')}`,
        })
        this.afterImport()
        return r
      },
      importFile: ({ data, name }) => {
        const r = importBackup(e, data, { from: `a backup file${name
          ? ` (${String(name).slice(0, 60)})`
          : ''}` })
        this.afterImport()
        return r
      },
      // a backup: saved on this computer first (the Homebridge UI's page can't always download files), then returned to the page
      exportData: () => {
        const d = e.toData()
        const data = {
          ...d,
          settings: { ...d.settings, web: undefined },
          exported: Date.now(),
          plugin: `${PLUGIN_NAME} ${VERSION}`,
        } // never the PIN or sign-ins
        const saved = saveBackup(this.dir, data)
        this.log.info(`Saved a backup: ${path.join(this.dir, 'backups', saved)}`)
        return { ...data, savedAs: saved }
      },
    }
  }

  // the addresses Find Shellys asks: this computer's home networks (the tests swap in their pretend Shellys)
  scanAddresses() {
    return scanTargets()
  }

  async findShellys() {
    const targets = this.scanAddresses()
    if (!targets.hosts.length) {
      throw Object.assign(
        new Error(
          'This computer doesn\'t seem to be on a home network, so there\'s nowhere to look. Add Shellys by address instead.',
        ),
        { user: true },
      )
    }
    this.log.info(`Looking for Shellys at ${targets.hosts.length} addresses on ${targets.networks.join(', ')}…`)
    const r = await findShellys({ targets })
    this.log.info(`Found ${r.found.length} Shelly${r.found.length === 1
      ? ''
      : 's'} in ${Math.round(r.ms / 1000)} s.`)
    // how its readings are named, so one added under another address still shows as added
    for (const s of r.found) {
      s.idPrefix = s.id
        ? `${{ rpc: 'shrpc', gen1: 'shg1', homekit: 'shk' }[s.kind]}:${s.id}:`
        : null
    }
    return r
  }

  afterImport() {
    if (this.engine.matterDevices.length) {
      this.matterDevices.connectAll()
    }
    this.em.set(this.engine.settings.em.host, this.engine.settings.em.channel)
  }
}

// Matter only starts for a child bridge whose settings Homebridge accepts: say exactly what to fix
function checkBridgeConfig(api, log) {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(api.user.configPath(), 'utf8'))
  } catch {
    return
  }
  const plats = cfg.platforms || []
  const blocks = [
    ...plats,
    ...(cfg.accessories || []),
  ]
  const mine = plats.find(p => p.platform === PLATFORM_NAME)
  if (plats.filter(p => p.platform === PLATFORM_NAME).length > 1) {
    log.warn(
      'There are two ShellyHomeEnergy blocks in config.json. Keep one (the one with your child bridge settings) and restart.',
    )
  }
  const b = mine?._bridge
  if (!b) {
    log.warn(
      'This plugin isn\'t on a child bridge. On the Plugins tab, open its ⋮ menu → Bridge Settings, turn on the child bridge and Matter, Save, and restart.',
    )
    return
  }
  if (!b.matter || b.matter.enabled === false) {
    log.warn(
      'Matter is off for this plugin\'s child bridge. Turn on "Enable Matter" in its Bridge Settings, Save, and restart.',
    )
    return
  }
  for (const o of blocks) {
    if (o === mine || !o._bridge) {
      continue
    }
    const who = `"${o.name || o.platform || o.accessory}"`
    if (o._bridge.username && o._bridge.username === b.username) {
      log.warn(
        `This plugin's child bridge has the same bridge ID as ${who}. Remove one of them in JSON Config and restart.`,
      )
    }
    if (b.matter.port && o._bridge.matter?.port === b.matter.port) {
      log.warn(
        `This plugin's Matter port ${b.matter.port} is also used by ${who}, so Homebridge will turn Matter off for one of them. Change the port in Bridge Settings and restart.`,
      )
    }
  }
  if (b.matter.port && cfg.bridge?.matter?.port === b.matter.port) {
    log.warn(
      `This plugin's Matter port ${b.matter.port} is also the main bridge's Matter port. Change one of them and restart.`,
    )
  }
}
