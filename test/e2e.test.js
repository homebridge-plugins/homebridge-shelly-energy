/**
 * The plugin inside Homebridge's own API and HAP, against a pretend Shelly EM and a stand-in
 * Matter API that keeps Homebridge's rules.
 */
import fs from 'node:fs'
import path from 'node:path'

import { uuid as hapUuid } from '@homebridge/hap-nodejs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { startFakeEm } from './fake-shelly.js'
import { asHomeHubSeesIt, boot, loadHomebridge, sleep, useStorage } from './harness.js'
import { makeMatter, withMatter } from './matter-stand-in.js'

const EM_PORT = 18831
const backup = JSON.parse(fs.readFileSync(new URL('./fixtures/backup.json', import.meta.url), 'utf8'))

let em
let run
let storage

function cfg(extra = {}) {
  return {
    platform: 'ShellyHomeEnergy',
    name: 'Shelly Energy',
    host: `127.0.0.1:${EM_PORT}`,
    webPort: 0,
    ...extra,
  }
}

/** Starts the plugin with Matter on, and waits for its first whole-house reading. */
async function start(config = cfg(), { restored = [] } = {}) {
  fs.rmSync(path.join(storage, 'home-energy'), { recursive: true, force: true })
  let m
  run = boot(config, {
    setup: (api) => {
      m = makeMatter(api, { restored })
      withMatter(m)(api)
    },
  })
  run.m = m
  await vi.waitFor(() => expect(run.platform.emStatus?.ok).toBe(true), { timeout: 5000 })
  return run
}

const otherUuid = () => hapUuid.generate('shelly-appliances:__other__')

beforeAll(async () => {
  await loadHomebridge()
  storage = useStorage()
  em = startFakeEm(EM_PORT)
})

afterEach(() => {
  run?.api.signalShutdown()
  run = undefined
  em.st.w = 350
})

afterAll(() => {
  em.close()
})

describe('matter outlets', () => {
  it('publishes "Other" with the whole house\'s watts', async () => {
    await start()
    await vi.waitFor(() => expect(run.m.registered.get(otherUuid())?.state.electricalPowerMeasurement.activePower).toBeGreaterThan(300000), { timeout: 8000 })
    const other = run.m.registered.get(otherUuid())
    expect(other.displayName).toBe('Other appliances')
    expect(other.manufacturer).toBe('Homebridge Shelly Energy')
    expect(other.state.onOff.onOff).toBe(true)
    expect(run.m.log.errors).toEqual([])
  }, 15000)

  it('sends fresh values to an outlet Homebridge restored from its cache', async () => {
    const uuid = hapUuid.generate('shelly-appliances:__other__')
    em.st.w = 0
    await start(cfg(), {
      restored: [
        {
          UUID: uuid,
          displayName: 'Other appliances',
          clusters: {
            onOff: { onOff: true },
            electricalPowerMeasurement: { activePower: 9999000 },
            electricalEnergyMeasurement: {
              cumulativeEnergyImported: { energy: 1 },
            },
          },
        },
      ],
    })
    await vi.waitFor(() => expect(run.m.registered.get(uuid)?.restored).toBe(false), { timeout: 5000 })
    await vi.waitFor(() => expect(run.m.registered.get(uuid).state.electricalPowerMeasurement.activePower).toBe(0), { timeout: 5000 })
    expect(run.m.registered.get(uuid).state.onOff.onOff).toBe(false)
    expect(run.m.log.errors).toEqual([])
  })
})

describe('homekit tiles', () => {
  it('shows the running tiles of a restored backup the way a home hub reads them, without warnings', async () => {
    await start()
    await run.platform.actions().importFile({
      data: structuredClone(backup),
      name: 'backup.json',
    })
    await vi.waitFor(() => expect(run.registered.length).toBeGreaterThan(0), { timeout: 3000 })
    const { count } = await asHomeHubSeesIt(run.hap, run.registered)
    expect(count).toBe(run.registered.length)
    for (const a of run.registered) {
      a._associatedHAPAccessory.on('characteristic-warning', w => run.warnings.push(`${a.displayName}: ${w.message}`))
    }
    run.platform.hap.pushAll(true)
    expect(run.warnings).toEqual([])
  })
  it('renames a tile in Homebridge and in HAP when its appliance is renamed', async () => {
    await start()
    await run.platform.actions().importFile({
      data: structuredClone(backup),
      name: 'backup.json',
    })
    await vi.waitFor(() => expect(run.registered.length).toBeGreaterThan(0), { timeout: 3000 })
    const kettle = backup.sigs.find(s => s.name === 'Kettle')
    const tile = run.registered.find(a => a.UUID === hapUuid.generate(`shelly-appliances-faucet:${kettle.id}`))
    run.platform.actions().editSig({ id: kettle.id, name: 'Big Kettle' })
    expect(tile.displayName).toBe('Big Kettle')
    // HAP's own copy of the name, which a plain assignment leaves behind
    expect(tile._associatedHAPAccessory.displayName).toBe('Big Kettle')
  })
})

describe('shutdown', () => {
  it('stops reading the meter and closes the settings page link', async () => {
    await start()
    run.api.signalShutdown()
    const gets = em.st.gets
    await sleep(2500)
    expect(em.st.gets).toBe(gets)
    expect(fs.existsSync(`${run.api.user.storagePath()}/home-energy/control.json`)).toBe(false)
    expect(fs.existsSync(`${run.api.user.storagePath()}/home-energy/state.json`)).toBe(true)
    run = undefined
  })
})
