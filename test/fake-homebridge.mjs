// A stand-in Homebridge 2.x API: enough of HAP (services, characteristics, accessories) and of api.matter for the tiles
// and the platform to run without Homebridge. Records what was registered, removed and updated.
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const uuid = {
  generate: (s) => {
    const h = crypto.createHash('sha1').update(String(s)).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase()
  },
}

class Char {
  constructor(name) {
    this.name = name
    this.value = null
    this.getter = null
    this.setter = null
    this.props = {}
  }

  onGet(f) {
    this.getter = f
    return this
  }

  onSet(f) {
    this.setter = f
    return this
  }

  setProps(p) {
    Object.assign(this.props, p)
    return this
  }

  updateValue(v) {
    this.value = v
    return this
  }

  async get() {
    return this.getter
      ? this.getter()
      : this.value
  }
}
const CHARS = [
  'Name',
  'Manufacturer',
  'Model',
  'SerialNumber',
  'On',
  'OccupancyDetected',
  'ContactSensorState',
  'MotionDetected',
  'Active',
  'InUse',
  'ValveType',
  'SetDuration',
  'RemainingDuration',
  'OutletInUse',
  'CurrentAirPurifierState',
  'TargetAirPurifierState',
  'CurrentHumidifierDehumidifierState',
  'TargetHumidifierDehumidifierState',
  'CurrentRelativeHumidity',
  'CurrentHeaterCoolerState',
  'TargetHeaterCoolerState',
  'CurrentTemperature',
]
const Characteristic = Object.fromEntries(CHARS.map(n => [n, n]))
Object.defineProperty(Characteristic, 'ValveType', {
  value: Object.assign(new String('ValveType'), { WATER_FAUCET: 3 }),
})
class Svc {
  constructor(displayName) {
    this.displayName = displayName
    this.chars = new Map()
    this.UUID = this.constructor.UUID
  }

  getCharacteristic(c) {
    const k = String(c)
    if (!this.chars.has(k)) {
      this.chars.set(k, new Char(k))
    }
    return this.chars.get(k)
  }

  setCharacteristic(c, v) {
    this.getCharacteristic(c).value = v
    return this
  }

  updateCharacteristic(c, v) {
    this.getCharacteristic(c).value = v
    return this
  }

  value(c) {
    return this.chars.get(String(c))?.value
  }
}
function mk(n) {
  const C = class extends Svc {}
  C.UUID = n
  Object.defineProperty(C, 'name', { value: n })
  return C
}
const Service = Object.fromEntries(
  [
    'AccessoryInformation',
    'Switch',
    'Outlet',
    'Lightbulb',
    'Fanv2',
    'AirPurifier',
    'HeaterCooler',
    'OccupancySensor',
    'ContactSensor',
    'MotionSensor',
    'Valve',
    'HumidifierDehumidifier',
  ].map(n => [
    n,
    mk(n),
  ]),
)
class PlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName
    this.UUID = UUID
    this.context = {}
    this.services = [
      new Service.AccessoryInformation(),
    ]
  }

  getService(T) {
    return this.services.find(s => s instanceof T)
  }

  addService(T, name) {
    const s = new T(name)
    this.services.push(s)
    return s
  }

  removeService(s) {
    this.services = this.services.filter(x => x !== s)
  }
}

export function fakeApi({ storage, configPath, matter = true, hap = true } = {}) {
  const rec = {
    hapReg: [],
    hapUnreg: [],
    hapUpd: [],
    mReg: [],
    mUnreg: [],
    mUpd: [],
    mState: [],
  }
  const mRegistered = new Set()
  const api = Object.assign(new EventEmitter(), {
    version: 2.7,
    serverVersion: '2.5.0',
    rec,
    user: {
      storagePath: () => storage,
      configPath: () => configPath,
    },
    hap: hap
      ? { uuid, Service, Characteristic }
      : undefined,
    platformAccessory: PlatformAccessory,
    registerPlatform(...a) {
      const Cls = a.pop()
      this.platformName = a.pop()
      this.Platform = Cls
    },
    registerPlatformAccessories(p, n, list) {
      rec.hapReg.push(...list)
    },
    unregisterPlatformAccessories(p, n, list) {
      rec.hapUnreg.push(...list)
    },
    updatePlatformAccessories(list) {
      rec.hapUpd.push(...list)
    },
    isHapEnabled: () => hap,
    isMatterEnabled: () => matter,
    isMatterAvailable: () => matter,
    matter: matter
      ? {
          uuid,
          deviceTypes: { OnOffOutlet: 'OnOffOutlet' },
          async registerPlatformAccessories(p, n, list) {
            for (const a of list) {
              if (mRegistered.has(a.UUID)) {
                throw new Error('already registered')
              }
              mRegistered.add(a.UUID)
              rec.mReg.push(a)
            }
          },
          async unregisterPlatformAccessories(p, n, list) {
            for (const a of list) {
              if (!mRegistered.has(a.UUID)) {
                throw new Error('not registered')
              }
              mRegistered.delete(a.UUID)
              rec.mUnreg.push(a)
            }
          },
          async updatePlatformAccessories(list) {
            rec.mUpd.push(...list)
          },
          async updateAccessoryState(u, cluster, attrs) {
            rec.mState.push({ u, cluster, attrs })
          },
        }
      : undefined,
  })
  return api
}
export { Characteristic, PlatformAccessory, Service, uuid }

export function fakeLog() {
  const lines = []
  const log = Object.assign((...a) => lines.push([
    'info',
    a.join(' '),
  ]), {
    info: (...a) => lines.push([
      'info',
      a.join(' '),
    ]),
    warn: (...a) => lines.push([
      'warn',
      a.join(' '),
    ]),
    error: (...a) => lines.push([
      'error',
      a.join(' '),
    ]),
    debug: () => {},
    success: (...a) => lines.push([
      'info',
      a.join(' '),
    ]),
  })
  log.lines = lines
  return log
}
