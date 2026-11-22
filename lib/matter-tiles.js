// Each appliance in Apple Home as a Matter outlet with live power (ElectricalPowerMeasurement.activePower, mW) and lifetime
// energy (ElectricalEnergyMeasurement.cumulativeEnergyImported, mWh), plus an "Other" outlet for what the appliances don't
// explain, so the outlets add up to the whole-house reading.
//
// Identities (UUID seed "shelly-appliances:<id>", serial "SA-<id>") are fixed: changing them would make every tile new in Apple
// Home and break automations.
// Every cached outlet under this platform is this plugin's own; any it no longer wants is removed.

import { DISPLAY } from './constants.js'
import { dayKey, daysBack } from './engine-util.js'

export const OTHER_ID = '__other__'
const NAME_MAX = 32

export class MatterTiles {
  constructor({ api, log, engine, pluginName, platformName, manufacturer = DISPLAY, cached = [] }) {
    this.api = api
    this.log = log
    this.engine = engine
    this.pluginName = pluginName
    this.platformName = platformName
    this.manufacturer = manufacturer
    this.registered = new Map() // id -> { uuid, name, last }
    this.cached = cached // outlets Homebridge restored from its cache (configureMatterAccessory), checked at the first sync
    this.syncing = Promise.resolve()
    this.withEnergy = true
  }

  get m() {
    return this.api.matter
  }

  uuidFor(id) {
    return this.m.uuid.generate(`shelly-appliances:${id}`)
  }

  wanted() {
    const list = []
    for (const s of this.engine.sigs) {
      if (s.exposed !== false) {
        list.push({ id: s.id, name: s.name })
      }
    }
    const o = this.engine.settings.other
    if (o.on) {
      list.push({ id: OTHER_ID, name: o.name })
    }
    return list
  }

  build({ id, name }) {
    const st = this.state(id)
    const acc = {
      UUID: this.uuidFor(id),
      displayName: String(name).slice(0, NAME_MAX),
      deviceType: this.m.deviceTypes.OnOffOutlet,
      serialNumber: `SA-${id === OTHER_ID
        ? 'OTHER'
        : id}`.slice(0, 32),
      manufacturer: this.manufacturer,
      model: id === OTHER_ID
        ? 'Unrecognised load'
        : 'Appliance energy',
      context: { applianceId: id },
      clusters: {
        onOff: { onOff: st.on },
      },
      // a measurement, not a switch: tapping it in the Home app puts it back shortly afterwards
      handlers: {
        onOff: {
          on: async () => this.revertSoon(id),
          off: async () => this.revertSoon(id),
        },
      },
    }
    if (this.withEnergy) {
      acc.clusters.electricalPowerMeasurement = { activePower: st.mW }
      acc.clusters.electricalEnergyMeasurement = {
        cumulativeEnergyImported: { energy: st.mWh },
      }
    }
    return acc
  }

  state(id) {
    const E = this.engine
    const now = E.now
    if (id === OTHER_ID) {
      const w = now ? now.alloc.other : 0
      return {
        on: w >= 5,
        mW: Math.round(w * 1000),
        mWh: Math.round(E.otherKwh * 1e6),
      }
    }
    const s = E.sigById(id)
    const w = now?.alloc.per[id] || 0
    const running = !!E.running[id]
    // steady outlet: true = always on (fridge), 'idle' = on through gaps shorter than steadyIdleMin; watts then the 24 h average
    let on = running
    let steady = false
    if (s?.steadyOutlet === true) {
      on = true
      steady = true
    } else if (s?.steadyOutlet === 'idle') {
      const off = E.lastOffAt[id]
      on = running || (off != null && Date.now() - off < (s.steadyIdleMin ?? 10) * 60000)
      steady = on
    }
    const watts = steady
      ? this.avg24h(id)
      : w
    return {
      on,
      mW: Math.round(watts * 1000),
      mWh: Math.round((s?.kwh || 0) * 1e6),
    }
  }

  avg24h(id) {
    const E = this.engine
    const now = Date.now()
    const today = E.energy[dayKey(now)]?.apps?.[id] || 0
    const yest = E.energy[daysBack(now, 1)]?.apps?.[id] || 0
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const hrs = Math.min(24, Math.max(0, (now - start.getTime()) / 3600e3))
    return Math.round(((today + yest * ((24 - hrs) / 24)) * 1000) / 24)
  }

  revertSoon(id) {
    const r = this.registered.get(id)
    if (!r) {
      return
    }
    this.log.info(`"${r.name}" shows an appliance's power and can't be switched. Its tile shows whether it's running.`)
    setTimeout(() => {
      r.last = {}
      this.push(id).catch(() => {})
    }, 1500)
  }

  sync() {
    this.syncing = this.syncing.then(() => this._sync()).catch(e => this.log.error(`Matter tiles: ${e.message}`))
    return this.syncing
  }

  async unregister(id, name) {
    const full = [
      this.build({ id, name: name || 'Removed' }),
    ]
    try {
      await this.m.unregisterPlatformAccessories(this.pluginName, this.platformName, full)
      return true
    } catch {
      // Homebridge only half-knows an accessory restored from its cache: register it, then remove it
      try {
        await this.m.registerPlatformAccessories(this.pluginName, this.platformName, full)
        await this.m.unregisterPlatformAccessories(this.pluginName, this.platformName, full)
        return true
      } catch (e2) {
        this.log.warn(
          `Couldn't remove "${name}" from Matter (${e2.message}). If it still shows in Apple Home, remove it in the Homebridge UI: Settings → Remove Single Cached Accessory.`,
        )
        return false
      }
    }
  }

  async _sync() {
    const want = this.wanted()
    const wantIds = new Set(want.map(w => w.id))
    // 1. remove outlets this plugin published that are no longer wanted
    const removed = new Set()
    for (const id of [
      ...new Set([
        ...this.engine.matterIds,
        ...this.registered.keys(),
      ]),
    ].filter(
      id => !wantIds.has(id),
    )) {
      const name = this.registered.get(id)?.name || (id === OTHER_ID
        ? 'Other appliances'
        : 'a removed appliance')
      await this.unregister(id, name)
      this.registered.delete(id)
      this.log.info(`Removed "${name}" from Matter`)
      removed.add(this.uuidFor(id))
    }
    // ...and outlets Homebridge restored that this plugin no longer knows about (say, after a lost state.json)
    const wantUuids = new Set(want.map(w => this.uuidFor(w.id)))
    for (const acc of this.cached.splice(0)) {
      if (wantUuids.has(acc.UUID) || removed.has(acc.UUID)) {
        continue
      }
      try {
        await this.m.unregisterPlatformAccessories(this.pluginName, this.platformName, [acc])
        this.log.info(`Removed "${acc.displayName}" from Matter`)
      } catch (e) {
        this.log.warn(`Couldn't remove "${acc.displayName}" from Matter (${e.message}).`)
      }
    }
    // 2. add new ones (each on its own, so one problem accessory can't stop the others)
    for (const w of want.filter(x => !this.registered.has(x.id))) {
      try {
        await this.m.registerPlatformAccessories(this.pluginName, this.platformName, [
          this.build(w),
        ])
      } catch (e) {
        if (!this.withEnergy) {
          this.log.warn(`Couldn't publish "${w.name}" to Matter: ${e.message}`)
          continue
        }
        try {
          this.withEnergy = false
          await this.m.registerPlatformAccessories(this.pluginName, this.platformName, [
            this.build(w),
          ])
          this.log.warn(
            `Couldn't publish power readings for "${w.name}" (${e.message}); publishing plain outlets instead. Homebridge 2.4.0 or newer is needed for watts.`,
          )
        } catch (e2) {
          this.withEnergy = true
          this.log.warn(`Couldn't publish "${w.name}" to Matter: ${e2.message}`)
          continue
        }
      }
      this.registered.set(w.id, {
        uuid: this.uuidFor(w.id),
        name: w.name,
        last: {},
      })
      this.log.info(`Published "${w.name}" to Matter`)
    }
    // 3. renames (the Home app keeps its own names; this is the name new controllers see)
    for (const w of want.filter(x => this.registered.has(x.id) && this.registered.get(x.id).name !== x.name)) {
      try {
        await this.m.updatePlatformAccessories([
          {
            ...this.build(w),
            uuid: this.uuidFor(w.id),
          },
        ])
      } catch (e) {
        this.log.debug(`Renaming "${w.name}" in Matter failed: ${e.message}`)
      }
      this.registered.get(w.id).name = w.name
    }
    const ids = [
      ...this.registered.keys(),
    ]
    if (JSON.stringify(ids) !== JSON.stringify(this.engine.matterIds)) {
      this.engine.matterIds = ids
      this.engine.dirty = true
    }
    const n = this.registered.size
    const summary = `${n} outlet${
      n === 1
        ? ''
        : 's'
    } on Matter, ${this.withEnergy ? 'with power readings' : 'WITHOUT power readings (see the warning above)'}`
    if (summary !== this.lastSummary) {
      this.log.info(summary)
      this.lastSummary = summary
    }
    await this.pushAll()
  }

  // send current values; only what changed, to keep Matter traffic low
  async push(id) {
    const r = this.registered.get(id)
    if (!r) {
      return
    }
    const st = this.state(id)
    const last = r.last
    if (st.on !== last.on) {
      await this.m.updateAccessoryState(r.uuid, 'onOff', { onOff: st.on })
      last.on = st.on
    }
    if (!this.withEnergy) {
      return
    }
    if (last.mW === undefined || Math.abs(st.mW - last.mW) >= 2000 || (st.mW === 0) !== (last.mW === 0)) {
      await this.m.updateAccessoryState(r.uuid, 'electricalPowerMeasurement', { activePower: st.mW })
      last.mW = st.mW
    }
    if (last.mWh === undefined || st.mWh - last.mWh >= 1000 || Date.now() - (last.eT || 0) > 60000) {
      if (st.mWh !== last.mWh) {
        await this.m.updateAccessoryState(r.uuid, 'electricalEnergyMeasurement', {
          cumulativeEnergyImported: { energy: st.mWh },
        })
      }
      last.mWh = st.mWh
      last.eT = Date.now()
    }
  }

  async pushAll() {
    for (const id of this.registered.keys()) {
      try {
        await this.push(id)
      } catch (e) {
        this.log.debug(`Matter update for ${id} failed: ${e.message}`)
      }
    }
  }
}
