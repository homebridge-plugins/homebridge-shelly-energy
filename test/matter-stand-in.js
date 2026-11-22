/**
 * A stand-in for Homebridge's api.matter that keeps its rules: required fields, known
 * cluster names, no updates before registration, refusals while the Matter server starts,
 * and cached accessories restored (with their state but empty handlers) before the plugin starts.
 */
const CLUSTERS = new Set([
  'onOff',
  'electricalPowerMeasurement',
  'electricalEnergyMeasurement',
])

export function makeMatter(api, { startingRefusals = 0, restored = [] } = {}) {
  const registered = new Map()
  const log = { errors: [], registerCalls: 0, unregistered: [] }
  let refusals = startingRefusals
  const partStates = a => Object.fromEntries((a.parts || []).map(p => [
    p.id,
    structuredClone(p.clusters || {}),
  ]))
  for (const a of restored) {
    registered.set(a.UUID, {
      ...a,
      state: structuredClone(a.clusters || {}),
      partState: partStates(a),
      restored: true,
    })
  }
  const deviceTypes = {
    OnOffOutlet: { name: 'OnOffPlugInUnitDevice' },
    BridgedNode: { name: 'BridgedNodeEndpoint' },
  }
  const matter = {
    uuid: api.hap.uuid,
    deviceTypes,
    async registerPlatformAccessories(pluginName, platformName, accessories) {
      log.registerCalls++
      if (refusals-- > 0) {
        throw new Error('Cannot register Matter accessories yet - the Matter server for this bridge is still starting.')
      }
      for (const a of accessories) {
        for (const field of [
          'UUID',
          'displayName',
          'deviceType',
          'manufacturer',
          'model',
          'serialNumber',
        ]) {
          if (!a[field]) {
            log.errors.push(`missing ${field}`)
          }
        }
        for (const field of [
          'displayName',
          'model',
          'manufacturer',
          'serialNumber',
        ]) {
          if (String(a[field]).length > 32) {
            log.errors.push(`${field} longer than 32: ${a[field]}`)
          }
        }
        for (const c of [
          a,
          ...(a.parts || []),
        ].flatMap(p => Object.keys(p.clusters || {}))) {
          if (!CLUSTERS.has(c)) {
            log.errors.push(`unknown cluster ${c}`)
          }
        }
        const existing = registered.get(a.UUID)
        if (existing && !existing.restored) {
          log.errors.push(`registered twice: ${a.displayName}`)
        }
        registered.set(a.UUID, {
          ...a,
          state: existing?.restored
            ? existing.state
            : structuredClone(a.clusters || {}),
          partState: existing?.restored
            ? existing.partState
            : partStates(a),
          restored: false,
        })
      }
    },
    // Homebridge's odd one out: one argument, not three
    async updatePlatformAccessories(accessories) {
      if (!Array.isArray(accessories)) {
        log.errors.push('updatePlatformAccessories takes one array')
        return
      }
      for (const a of accessories) {
        const existing = registered.get(a.UUID)
        if (!existing || existing.restored) {
          log.errors.push(`update of an unregistered accessory: ${a.displayName}`)
          continue
        }
        existing.displayName = a.displayName
      }
    },
    async unregisterPlatformAccessories(pluginName, platformName, accessories) {
      for (const a of accessories) {
        registered.delete(a.UUID)
        log.unregistered.push(a.displayName)
      }
    },
    async updateAccessoryState(uuid, cluster, attrs, partId) {
      const a = registered.get(uuid)
      if (!a || a.restored) {
        log.errors.push(`update before registration: ${cluster}`)
        throw new Error('not registered')
      }
      const target = partId ? a.partState[partId] : a.state
      if (!target || !(cluster in target)) {
        log.errors.push(`update to ${cluster} not declared on ${partId || 'accessory'}`)
        return
      }
      Object.assign(target[cluster], attrs)
    },
    async getAccessoryState(uuid, cluster, partId) {
      const a = registered.get(uuid)
      return partId ? a?.partState[partId]?.[cluster] : a?.state[cluster]
    },
  }
  return { matter, registered, log }
}

/** What `setup` in boot() needs to turn Matter on (or off) for a bridge. */
export function withMatter(m, matterOn = true) {
  return (api) => {
    if (matterOn) {
      Object.defineProperty(api, 'matter', { value: m.matter, configurable: true })
    }
    api.isMatterEnabled = () => matterOn
  }
}
