// Optional HomeKit (HAP) tiles: a "running" indicator per appliance (faucet, switch, outlet, light, fan, air purifier,
// humidifier, dehumidifier, heater, air conditioner, occupancy, contact or motion) and a
// "Cheap Power Now" occupancy sensor for automations. HAP because Apple Home doesn't accept Matter water valves.
// UUID seed "shelly-appliances-faucet:<id>" is fixed: changing it would make every tile new in Apple Home.
// Every cached tile under this platform is this plugin's own; any it no longer wants is removed.
import { DISPLAY } from './constants.js'
import { cheapNow } from './tariff.js'

export const CHEAP_ID = '__alert_cheap__'

// What each running tile sets in Apple Home. HAP values: current state while running (0 = inactive when not) and the fixed mode.
//   HumidifierDehumidifier: current 2 humidifying / 3 dehumidifying, target 1 humidifier / 2 dehumidifier
//   HeaterCooler: current 2 heating / 3 cooling, target 1 heat / 2 cool · AirPurifier: current 2 purifying, target 1 auto
// Alarm-type tiles (smoke, CO, leak, security), locks and garage doors are left out on purpose: Apple Home treats them as
// critical or secure, so a "running" signal there would set off alerts or ask for a passcode.
const TYPES = {
  faucet: { active: true },
  switch: { on: true },
  outlet: { on: true },
  light: { on: true },
  fan: { active: true },
  purifier: {
    active: true,
    current: ['CurrentAirPurifierState', 2],
    target: ['TargetAirPurifierState', 1],
  },
  humidifier: {
    active: true,
    current: ['CurrentHumidifierDehumidifierState', 2],
    target: ['TargetHumidifierDehumidifierState', 1],
    humidity: true,
  },
  dehumidifier: {
    active: true,
    current: ['CurrentHumidifierDehumidifierState', 3],
    target: ['TargetHumidifierDehumidifierState', 2],
    humidity: true,
  },
  heater: {
    active: true,
    current: ['CurrentHeaterCoolerState', 2],
    target: ['TargetHeaterCoolerState', 1],
    temperature: true,
  },
  cooler: {
    active: true,
    current: ['CurrentHeaterCoolerState', 3],
    target: ['TargetHeaterCoolerState', 2],
    temperature: true,
  },
  occupancy: {},
  contact: {},
  motion: {},
}

export class HapTiles {
  constructor({ api, log, engine, pluginName, platformName, manufacturer = DISPLAY }) {
    this.api = api
    this.log = log
    this.engine = engine
    this.pluginName = pluginName
    this.platformName = platformName
    this.manufacturer = manufacturer
    this.cached = new Map() // UUID -> PlatformAccessory (from Homebridge's cache, or created here)
    this.tiles = new Map() // tile id -> { acc, svc, statusType, applianceId, last }
    this.warned = false
  }

  get hapOn() {
    if (!this.api.hap || !this.api.platformAccessory) {
      return false
    }
    return typeof this.api.isHapEnabled === 'function'
      ? this.api.isHapEnabled()
      : true
  }

  uuidFor(id) {
    return this.api.hap.uuid.generate(`shelly-appliances-faucet:${id}`)
  }

  configureAccessory(acc) {
    this.cached.set(acc.UUID, acc)
  }

  wanted() {
    const want = []
    for (const s of this.engine.sigs) {
      if (!s.statusType || s.statusType === 'none') {
        continue
      }
      const n = Math.max(1, Math.min(10, Math.round(+s.statusCount) || 1))
      // copies so one can sit in each room; the first keeps the appliance's own id, so nothing re-pairs
      for (let i = 1; i <= n; i++) {
        want.push({
          id: i === 1
            ? s.id
            : `${s.id}:${i}`,
          name: i === 1
            ? s.name
            : `${s.name} ${i}`,
          statusType: s.statusType,
          applianceId: s.id,
        })
      }
    }
    if (this.engine.settings.cheapTile) {
      want.push({ id: CHEAP_ID, name: 'Cheap Power Now', cheap: true })
    }
    return want
  }

  sync() {
    if (!this.api.hap) {
      return
    }
    const want = this.wanted()
    if (want.length && !this.hapOn) {
      if (!this.warned) {
        this.log.warn(
          'Running tiles and "Cheap Power Now" need HomeKit (HAP) turned on for this plugin\'s bridge, as well as Matter. Turn it on in the plugin\'s Bridge Settings and restart.',
        )
      }
      this.warned = true
      return
    }
    const byUuid = new Map(want.map(s => [
      this.uuidFor(s.id),
      s,
    ]))
    // every cached tile under this platform is this plugin's own: any no longer wanted goes (also after a lost state.json)
    const stale = [
      ...this.cached.values(),
    ].filter(a => !byUuid.has(a.UUID))
    if (stale.length) {
      this.remove(stale)
    }
    for (const [uuid, s] of byUuid) {
      let acc = this.cached.get(uuid)
      let isNew = false
      if (!acc) {
        acc = new this.api.platformAccessory(s.name, uuid)
        isNew = true
      }
      try {
        this.attach(acc, s)
      } catch (e) {
        this.log.warn(`Couldn't set up the tile "${s.name}": ${e.message}`)
        continue
      }
      if (isNew) {
        this.api.registerPlatformAccessories(this.pluginName, this.platformName, [acc])
        this.cached.set(uuid, acc)
        this.log.info(`Published the tile "${s.name}"`)
      } else if (acc.displayName !== s.name) {
        // Homebridge's way: it also renames HAP's copy (the Home app keeps the name it was given)
        acc.updateDisplayName(s.name)
        this.tiles.get(s.id)?.svc.setCharacteristic(this.api.hap.Characteristic.Name, s.name)
        this.api.updatePlatformAccessories([acc])
      }
    }
    const ids = want.map(w => w.id)
    if (JSON.stringify(ids) !== JSON.stringify(this.engine.hapIds)) {
      this.engine.hapIds = ids
      this.engine.dirty = true
    }
    this.pushAll(true)
  }

  remove(list) {
    if (!list.length) {
      return 0
    }
    try {
      this.api.unregisterPlatformAccessories(this.pluginName, this.platformName, list)
    } catch (e) {
      this.log.warn(`Couldn't remove ${list.length} tile(s): ${e.message}`)
      return 0
    }
    for (const a of list) {
      this.cached.delete(a.UUID)
      for (const [id, t] of this.tiles) {
        if (t.acc === a) {
          this.tiles.delete(id)
        }
      }
      this.log.info(`Removed the tile "${a.displayName}"`)
    }
    return list.length
  }

  statusSvc(acc, type) {
    const S = this.api.hap.Service
    const T
      = {
        switch: S.Switch,
        outlet: S.Outlet,
        light: S.Lightbulb,
        fan: S.Fanv2,
        purifier: S.AirPurifier,
        humidifier: S.HumidifierDehumidifier,
        dehumidifier: S.HumidifierDehumidifier,
        heater: S.HeaterCooler,
        cooler: S.HeaterCooler,
        occupancy: S.OccupancySensor,
        contact: S.ContactSensor,
        motion: S.MotionSensor,
      }[type] || S.Valve
    return acc.getService(T) || acc.addService(T)
  }

  // Apple Home requires a humidity (humidifier tiles) or temperature (heater / air conditioner tiles): a sensor this plugin
  // reads when there is one, otherwise a neutral figure
  humidity() {
    const h = this.engine.sensorAverage('Humidity')
    return h == null
      ? 50
      : Math.max(0, Math.min(100, Math.round(h)))
  }

  temperature() {
    const t = this.engine.sensorAverage('Temperature')
    return t == null
      ? 20
      : Math.max(-50, Math.min(100, t))
  }

  // remove services of another tile type (after an appliance's tile type is changed)
  dropOther(acc, keep) {
    const { Service } = this.api.hap
    for (const svc of [
      ...(acc.services || []),
    ]) {
      if (svc.UUID === Service.AccessoryInformation.UUID || svc === keep) {
        continue
      }
      try {
        acc.removeService(svc)
      } catch {}
    }
  }

  attach(acc, s) {
    const { Service, Characteristic } = this.api.hap
    acc.context.applianceId = s.id
    const info = acc.getService(Service.AccessoryInformation)
    if (s.cheap) {
      if (this.tiles.get(s.id)?.acc === acc) {
        return
      }
      info
        .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(Characteristic.Model, 'Cheapest electricity hours')
        .setCharacteristic(Characteristic.SerialNumber, 'SA-ALERT-CHEAP')
      const svc = acc.getService(Service.OccupancySensor) || acc.addService(Service.OccupancySensor, s.name)
      this.dropOther(acc, svc)
      svc
        .getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => (cheapNow(this.engine.settings.tariff)
          ? 1
          : 0))
      this.tiles.set(s.id, { acc, svc, cheap: true, last: null })
      return
    }
    const type = Object.hasOwn(TYPES, s.statusType)
      ? s.statusType
      : 'faucet'
    const prev = this.tiles.get(s.id)
    if (prev?.acc === acc && prev.statusType === type) {
      return
    }
    info
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, 'Appliance running indicator')
      .setCharacteristic(Characteristic.SerialNumber, `SAF-${s.id}`.slice(0, 64))
    const svc = this.statusSvc(acc, type)
    this.dropOther(acc, svc)
    svc.setCharacteristic(Characteristic.Name, s.name)
    const realId = s.applianceId || s.id
    const isOn = () => (this.engine.running[realId] ? 1 : 0)
    const revert = () => {
      this.log.info(`"${s.name}" can't be switched from Apple Home; its tile shows whether it's running.`)
      setTimeout(() => this.push(s.id, true), 1000)
    }
    const t = TYPES[type]
    const C = Characteristic
    if (t.on) {
      svc
        .getCharacteristic(C.On)
        .onGet(() => !!isOn())
        .onSet(revert)
    }
    if (type === 'outlet') {
      svc.getCharacteristic(C.OutletInUse).onGet(() => !!isOn())
    }
    if (t.active) {
      svc.getCharacteristic(C.Active).onGet(isOn).onSet(revert)
    }
    if (t.current) {
      svc.getCharacteristic(C[t.current[0]]).onGet(() => (isOn()
        ? t.current[1]
        : 0))
    } // 0 = inactive
    if (t.target) {
      svc
        .getCharacteristic(C[t.target[0]])
        .updateValue(t.target[1])
        .onGet(() => t.target[1])
        .onSet(revert)
    } // fixed mode; springs back
    if (t.humidity) {
      svc.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.humidity())
    }
    if (t.temperature) {
      svc.getCharacteristic(C.CurrentTemperature).onGet(() => this.temperature())
    }
    if (type === 'occupancy') {
      svc.getCharacteristic(C.OccupancyDetected).onGet(isOn)
    } else if (type === 'contact') {
      svc.getCharacteristic(C.ContactSensorState).onGet(() => (isOn()
        ? 1
        : 0)) // 1 = not detected (open) while running
    } else if (type === 'motion') {
      svc.getCharacteristic(C.MotionDetected).onGet(() => !!isOn())
    } else if (type === 'faucet') {
      svc.setCharacteristic(C.ValveType, C.ValveType.WATER_FAUCET)
      svc.getCharacteristic(C.InUse).onGet(isOn)
      // time left in this run, from the appliance's own usual run length (best effort; 4 h ceiling)
      svc
        .getCharacteristic(C.SetDuration)
        .setProps({ minValue: 0, maxValue: 4 * 3600 })
        .onGet(() => Math.min(4 * 3600, Math.round(this.engine.expectedRunSec(realId) || 0)))
        .onSet(() => {})
      svc
        .getCharacteristic(C.RemainingDuration)
        .setProps({ minValue: 0, maxValue: 4 * 3600 })
        .onGet(() => Math.min(4 * 3600, this.engine.remainingSec(realId) ?? 0))
    }
    this.tiles.set(s.id, {
      acc,
      svc,
      statusType: type,
      applianceId: realId,
      last: null,
    })
  }

  push(id, force = false) {
    const t = this.tiles.get(id)
    if (!t) {
      return
    }
    const { Characteristic: C } = this.api.hap
    if (t.cheap) {
      const v = cheapNow(this.engine.settings.tariff)
        ? 1
        : 0
      if (force || t.last !== v) {
        t.svc.updateCharacteristic(C.OccupancyDetected, v)
        t.last = v
      }
      return
    }
    const on = !!this.engine.running[t.applianceId]
    const T = TYPES[t.statusType] || TYPES.faucet
    // the faucet's countdown: the learned cycle it's in (or its usual run), refreshed every push so it follows a better match
    if (t.statusType === 'faucet' && on) {
      t.svc.updateCharacteristic(
        C.SetDuration,
        Math.min(4 * 3600, Math.round(this.engine.expectedRunSec(t.applianceId) || 0)),
      )
      t.svc.updateCharacteristic(C.RemainingDuration, Math.min(4 * 3600, this.engine.remainingSec(t.applianceId) ?? 0))
    }
    if (T.humidity) {
      t.svc.updateCharacteristic(C.CurrentRelativeHumidity, this.humidity())
    }
    if (T.temperature) {
      t.svc.updateCharacteristic(C.CurrentTemperature, this.temperature())
    }
    if (!force && t.last === on) {
      return
    }
    if (T.on) {
      t.svc.updateCharacteristic(C.On, on)
    }
    if (t.statusType === 'outlet') {
      t.svc.updateCharacteristic(C.OutletInUse, on)
    }
    if (T.active) {
      t.svc.updateCharacteristic(C.Active, on ? 1 : 0)
    }
    if (T.current) {
      t.svc.updateCharacteristic(C[T.current[0]], on ? T.current[1] : 0)
    }
    if (T.target) {
      t.svc.updateCharacteristic(C[T.target[0]], T.target[1])
    }
    if (t.statusType === 'occupancy') {
      t.svc.updateCharacteristic(C.OccupancyDetected, on ? 1 : 0)
    } else if (t.statusType === 'contact') {
      t.svc.updateCharacteristic(C.ContactSensorState, on ? 1 : 0)
    } else if (t.statusType === 'motion') {
      t.svc.updateCharacteristic(C.MotionDetected, on)
    } else if (t.statusType === 'faucet') {
      t.svc.updateCharacteristic(C.InUse, on ? 1 : 0)
    }
    t.last = on
  }

  pushAll(force = false) {
    for (const id of this.tiles.keys()) {
      try {
        this.push(id, force)
      } catch (e) {
        this.log.debug(`Tile update for ${id} failed: ${e.message}`)
      }
    }
  }
}
