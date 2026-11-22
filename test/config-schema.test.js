/**
 * The settings schema is checked by Homebridge's verification, and by the
 * Homebridge UI every time someone saves. These keep it valid for both.
 */
import { existsSync, readFileSync } from 'node:fs'

import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
const schemaFile = read('../config.schema.json')
const pkg = read('../package.json')
const validate = new Ajv({ strict: false, allErrors: true }).compile(schemaFile.schema)

/** Every place a field says "required": true, which json schema rejects. */
function requiredFlags(node, path = '$') {
  if (!node || typeof node !== 'object') {
    return []
  }
  const own = typeof node.required === 'boolean'
    ? [path]
    : []
  return [
    ...own,
    ...Object.entries(node.properties ?? {}).flatMap(([key, sub]) => requiredFlags(sub, `${path}.${key}`)),
    ...requiredFlags(node.items, `${path}[]`),
  ]
}

describe('the settings schema', () => {
  it('uses the same platform name as the plugin', async () => {
    const source = readFileSync(new URL('../lib/constants.js', import.meta.url), 'utf8')
    expect(schemaFile.pluginAlias).toBe(pkg.alias)
    expect(source).toContain(`export const PLATFORM_NAME = '${pkg.alias}'`)
    expect(source).toContain(`export const PLUGIN_NAME = '${pkg.name}'`)
  })

  it('is a dynamic platform, one per bridge, with a name field', () => {
    expect(schemaFile.pluginType).toBe('platform')
    expect(schemaFile.singular).toBe(true)
    expect(schemaFile.schema.properties.name).toBeTruthy()
  })

  it('lists required fields the json schema way, not as "required": true', () => {
    expect(requiredFlags(schemaFile.schema)).toEqual([])
    expect(schemaFile.schema.required).toEqual(['name'])
  })

  it('accepts the platform with only its name', () => {
    expect(validate({ name: 'Shelly Energy' }), JSON.stringify(validate.errors)).toBe(true)
  })

  it('accepts a full config', () => {
    const config = {
      name: 'Shelly Energy',
      host: '192.168.1.50',
      channel: 'auto',
      webPort: 8591,
      matterLogLevel: 'warn',
    }
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
  })

  it('points the homebridge ui at the settings page in lib', () => {
    expect(schemaFile.customUi).toBe(true)
    expect(existsSync(new URL(`../${schemaFile.customUiPath}/server.js`, import.meta.url))).toBe(true)
    expect(existsSync(new URL(`../${schemaFile.customUiPath}/public/index.html`, import.meta.url))).toBe(true)
  })
})
