// the Apple Home tiles against a stand-in Homebridge API: fixed identities, Other,
// running tiles of each type with copies, Cheap Power Now, renames, and never removing tiles this plugin didn't publish.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { it } from 'vitest'

import { fakeApi, fakeLog, PlatformAccessory, Service, uuid } from '../test/fake-homebridge.js'
import { Engine } from './engine.js'
import { CHEAP_ID, HapTiles } from './hap-tiles.js'
import { MatterTiles } from './matter-tiles.js'

function mkE() {
  return new Engine({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'he-t-')), 'state.json'),
    log: fakeLog(),
  })
}
const P = ['@homebridge-plugins/homebridge-shelly-energy', 'ShellyHomeEnergy']

it('matter outlets keep their fixed identities; Other carries the rest; values pushed; renames', async () => {
  const e = mkE()
  const api = fakeApi()
  const log = fakeLog()
  const s = e.newSig('Kettle', { id: 'abc123', watts: 2000 })
  s.id = 'abc123'
  e.newSig('Hidden', { exposed: false })
  const mt = new MatterTiles({
    api,
    log,
    engine: e,
    pluginName: P[0],
    platformName: P[1],
  })
  await mt.sync()
  assert.deepEqual(
    api.rec.mReg.map(a => a.UUID).sort(),
    [
      uuid.generate('shelly-appliances:abc123'),
      uuid.generate('shelly-appliances:__other__'),
    ].sort(),
  )
  const k = api.rec.mReg.find(a => a.serialNumber === 'SA-abc123')
  assert.equal(k.manufacturer, 'Homebridge Shelly Energy')
  assert.ok(k.clusters.electricalPowerMeasurement)
  e.running.abc123 = Date.now()
  e.processSample(Date.now() - 1000, 2300)
  e.processSample(Date.now(), 2300)
  await mt.pushAll()
  const st = api.rec.mState.filter(x => x.u === uuid.generate('shelly-appliances:abc123'))
  assert.ok(st.some(x => x.cluster === 'onOff' && x.attrs.onOff === true))
  assert.ok(st.some(x => x.cluster === 'electricalPowerMeasurement' && Math.abs(x.attrs.activePower - 2000000) < 1000))
  const oth = api.rec.mState.filter(x => x.u === uuid.generate('shelly-appliances:__other__'))
  assert.ok(oth.some(x => x.cluster === 'electricalPowerMeasurement' && Math.abs(x.attrs.activePower - 300000) < 1000))
  // rename, hide, Other off
  e.editSig('abc123', { name: 'Jug' })
  await mt.sync()
  assert.equal(api.rec.mUpd.at(-1).displayName, 'Jug')
  e.setSettings({
    other: { on: false },
  })
  await mt.sync()
  assert.ok(api.rec.mUnreg.some(a => a.UUID === uuid.generate('shelly-appliances:__other__')))
  assert.deepEqual(e.matterIds, ['abc123'])
})

it('hAP running tiles: each type, copies, the cached tile reused, and unknown cached tiles left alone', () => {
  const e = mkE()
  const api = fakeApi()
  const log = fakeLog()
  const s = e.newSig('Dishwasher', { statusType: 'faucet', statusCount: 2 })
  const h = new HapTiles({
    api,
    log,
    engine: e,
    pluginName: P[0],
    platformName: P[1],
  })
  // cached tiles: this appliance's (same seed, with a service of an older type), and one this plugin didn't publish
  const cachedMine = new PlatformAccessory('Dishwasher', uuid.generate(`shelly-appliances-faucet:${s.id}`))
  const hum = cachedMine.addService(Service.HumidifierDehumidifier)
  const weather = new PlatformAccessory('Outside Temperature', uuid.generate('shelly-appliances-faucet:__wx_temp__'))
  weather.context.applianceId = '__wx_temp__'
  h.configureAccessory(cachedMine)
  h.configureAccessory(weather)
  h.sync()
  assert.equal(api.rec.hapReg.length, 1, 'only the second copy is new')
  assert.equal(api.rec.hapReg[0].displayName, 'Dishwasher 2')
  assert.equal(api.rec.hapUnreg.length, 0, 'nothing removed')
  assert.ok(!cachedMine.services.includes(hum), 'an old service of another type is dropped')
  const valve = cachedMine.getService(Service.Valve)
  e.running[s.id] = Date.now()
  h.pushAll()
  assert.equal(valve.value('Active'), 1)
  assert.equal(valve.value('InUse'), 1)
  e.editSig(s.id, { statusType: 'occupancy', statusCount: 1 })
  h.sync()
  assert.equal(api.rec.hapUnreg.length, 1, 'the copy this plugin published is removed')
  assert.equal(api.rec.hapUnreg[0].displayName, 'Dishwasher 2')
  assert.equal(cachedMine.getService(Service.OccupancySensor).value('OccupancyDetected'), 1)
  assert.equal(cachedMine.getService(Service.Valve), undefined)
  assert.ok(
    !api.rec.hapUnreg.some(a => a.displayName === 'Outside Temperature'),
    'a cached tile it didn\'t publish stays',
  )
})

it(
  'every running tile type: on while running, back to off, a tap springs back, required readings filled in',
  async () => {
    const e = mkE()
    const api = fakeApi()
    const log = fakeLog()
    const h = new HapTiles({
      api,
      log,
      engine: e,
      pluginName: P[0],
      platformName: P[1],
    })
    const want = {
      switch: [
        'Switch',
        { On: true },
        { On: false },
      ],
      outlet: [
        'Outlet',
        { On: true, OutletInUse: true },
        { On: false, OutletInUse: false },
      ],
      light: [
        'Lightbulb',
        { On: true },
        { On: false },
      ],
      fan: [
        'Fanv2',
        { Active: 1 },
        { Active: 0 },
      ],
      purifier: [
        'AirPurifier',
        { Active: 1, CurrentAirPurifierState: 2, TargetAirPurifierState: 1 },
        { Active: 0, CurrentAirPurifierState: 0 },
      ],
      humidifier: [
        'HumidifierDehumidifier',
        { Active: 1, CurrentHumidifierDehumidifierState: 2, TargetHumidifierDehumidifierState: 1 },
        { CurrentHumidifierDehumidifierState: 0 },
      ],
      dehumidifier: [
        'HumidifierDehumidifier',
        { Active: 1, CurrentHumidifierDehumidifierState: 3, TargetHumidifierDehumidifierState: 2 },
        { CurrentHumidifierDehumidifierState: 0 },
      ],
      heater: [
        'HeaterCooler',
        { Active: 1, CurrentHeaterCoolerState: 2, TargetHeaterCoolerState: 1 },
        { Active: 0, CurrentHeaterCoolerState: 0 },
      ],
      cooler: [
        'HeaterCooler',
        { Active: 1, CurrentHeaterCoolerState: 3, TargetHeaterCoolerState: 2 },
        { Active: 0, CurrentHeaterCoolerState: 0 },
      ],
    }
    const sigs = Object.fromEntries(Object.keys(want).map(t => [
      t,
      e.newSig(`Thing ${t}`, { statusType: t }),
    ]))
    h.sync()
    const svcOf = t => api.rec.hapReg.find(a => a.displayName === `Thing ${t}`).getService(Service[want[t][0]])
    for (const t of Object.keys(want)) e.running[sigs[t].id] = Date.now()
    h.pushAll()
    for (const [t, [, on]] of Object.entries(want)) {
      for (const [k, v] of Object.entries(on)) assert.equal(svcOf(t).value(k), v, `${t} running: ${k}`)
    }
    for (const t of Object.keys(want)) delete e.running[sigs[t].id]
    h.pushAll()
    for (const [t, [, , off]] of Object.entries(want)) {
      for (const [k, v] of Object.entries(off)) assert.equal(svcOf(t).value(k), v, `${t} stopped: ${k}`)
    }
    // no sensors: neutral readings; with a Matter hub's sensor: its readings
    assert.equal(await svcOf('humidifier').getCharacteristic('CurrentRelativeHumidity').get(), 50)
    assert.equal(await svcOf('heater').getCharacteristic('CurrentTemperature').get(), 20)
    e.setSource('matter', [
      {
        id: 'mhub:44:3',
        name: 'Hall sensor',
        type: 'TemperatureSensor',
        values: { Temperature: 18.5, Humidity: 62 },
        protocol: 'matter',
      },
    ])
    h.pushAll()
    assert.equal(svcOf('dehumidifier').value('CurrentRelativeHumidity'), 62)
    assert.equal(svcOf('cooler').value('CurrentTemperature'), 18.5)
    // tapping in the Home app changes nothing
    svcOf('heater').getCharacteristic('TargetHeaterCoolerState').setter(2)
    assert.match(log.lines.at(-1)[1], /can't be switched from Apple Home/)
    // the type changed to another one using the same kind of service: same service, new mode
    e.editSig(sigs.humidifier.id, { statusType: 'dehumidifier' })
    h.sync()
    e.running[sigs.humidifier.id] = Date.now()
    h.pushAll()
    assert.equal(svcOf('humidifier').value('CurrentHumidifierDehumidifierState'), 3)
  },
)

it('cheap Power Now follows the time-of-use plan', () => {
  const e = mkE()
  const api = fakeApi()
  const log = fakeLog()
  const hNow = new Date().getHours()
  e.setSettings({
    tariff: {
      mode: 'tou',
      rate: 0.3,
      periods: [
        {
          name: 'Cheap',
          from: hNow,
          to: (hNow + 1) % 24,
          rate: 0.1,
        },
      ],
    },
  })
  e.setSettings({ cheapTile: true })
  const h = new HapTiles({
    api,
    log,
    engine: e,
    pluginName: P[0],
    platformName: P[1],
  })
  h.sync()
  const acc = api.rec.hapReg.find(a => a.UUID === uuid.generate(`shelly-appliances-faucet:${CHEAP_ID}`))
  assert.equal(acc.getService(Service.OccupancySensor).value('OccupancyDetected'), 1)
  e.setSettings({
    tariff: {
      mode: 'tou',
      rate: 0.3,
      periods: [
        {
          name: 'Cheap',
          from: (hNow + 2) % 24,
          to: (hNow + 3) % 24,
          rate: 0.1,
        },
      ],
    },
  })
  h.pushAll()
  assert.equal(acc.getService(Service.OccupancySensor).value('OccupancyDetected'), 0)
})

it('no HAP on the bridge: one clear warning, nothing registered', () => {
  const e = mkE()
  const api = fakeApi({ hap: true })
  const log = fakeLog()
  api.isHapEnabled = () => false
  e.newSig('Dryer', { statusType: 'switch' })
  const h = new HapTiles({
    api,
    log,
    engine: e,
    pluginName: P[0],
    platformName: P[1],
  })
  h.sync()
  h.sync()
  assert.equal(api.rec.hapReg.length, 0)
  assert.equal(log.lines.filter(([l]) => l === 'warn').length, 1)
})
