# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge dynamic platform that learns a home's appliances from one whole-house Shelly energy meter (EM / Pro EM / 3EM / Gen1 EM), reads Shelly devices and Matter devices on the home network for exact figures, and shows each appliance in Apple Home as a Matter outlet with live watts and energy, plus an "Other" outlet. Optional HAP "running" tiles and a "Cheap Power Now" tile. Local only: no accounts, no cloud, and it never switches anything. Written in JavaScript (ES modules), no build step. Created by @Wazza151.

## Commands

- **Lint**: `npm run lint` (eslint with zero warnings allowed)
- **Lint + fix**: `npm run lint:fix`
- **Test**: `npm test` (vitest, about 10 seconds)

CI runs lint, then the tests on Node 22, 24 and 26. Homebridge `^2.4.0` only (Matter energy clusters).

## Code Style

Uses `@antfu/eslint-config` with these key rules:
- Single quotes, no semicolons, 1tbs brace style
- Sorted imports/exports via `perfectionist` (keep a file's header comment ABOVE the imports, with a blank line after it, or the sorter drags it in among them)
- Node globals imported from `node:` modules (`Buffer`, `process`)
- Zero warnings tolerance (`--max-warnings=0`)
- No `process.env` reads in `lib/` (the Homebridge verification checker flags them; a test enforces it). Tests swap things on the platform instead: `platform.matterDevices.worker`, `platform.scanAddresses`.

## Architecture

- `lib/index.js` registers `ShellyHomeEnergyPlatform` (`lib/platform.js`) under the alias "ShellyHomeEnergy" (kept from the plugin this came from, as is the storage folder `home-energy`, so settings and learned appliances carry over). One platform per bridge (`singular`).
- `lib/platform.js`: wires everything, the actions the settings page can call (`actions()`), backups, Find Shellys, and bridge-config warnings. Stops everything on Homebridge shutdown.
- `lib/engine.js`: the energy engine. `processSample()` every second from the meter: step detection, learned appliances ("sigs"), runs and stages, measured appliances (`setSource()` from Shelly/Matter devices), estimated watts for on/off devices, daily/hourly energy, Other, summaries. Saves `state.json`: `changed()` = a change made by hand (saved within 30 s), `dataChanged()` / `dataDirty` = readings, power steps, runs (saved every 5 minutes; the file is a few MB).
- `lib/cycles.js` (an appliance's programmes from its plug's pattern), `lib/patterns.js` (unnamed step groups and suggestions), `lib/insights.js` (money-saving tips), `lib/tariff.js` (the electricity plan), `lib/engine-util.js` (helpers; `daysBack()` for past days, never `now - n * 24 h`).
- `lib/shelly-em.js`: polls the whole-house meter once a second. `lib/shelly-devices.js`: reads Shellys (HomeKit firmware, Gen1, Gen2+) every 3 s. `lib/discover.js`: Find Shellys (only when asked, home networks only). `lib/net.js`: device GETs (no redirects, capped size, timeout). `lib/hosts.js`: only home-network addresses, read the way `fetch` reads them.
- `lib/matter-devices.js` forks `lib/matter-controller.js` (matter.js `CommissioningController`, its own process) to join the user's Matter devices as a second controller and read them. Read-only. Its storage folder (`home-energy/matter-controller`, the fabric keys) is kept 0700. `lib/matter-hub.js` maps endpoint trees to devices.
- `lib/matter-tiles.js`: the Matter outlets (UUID seed `shelly-appliances:<id>`, fixed). Registers every outlet on each start (Homebridge restores cached Matter accessories with empty handlers) and removes cached ones it no longer wants (`configureMatterAccessory`). `lib/hap-tiles.js`: the HAP running tiles (seed `shelly-appliances-faucet:<id>`, fixed) and Cheap Power Now; renames with `updateDisplayName()`.
- `lib/control.js`: the link to the settings page: HTTP on a socket file (0600, or in a private mkdtemp folder when the storage path is long) plus a random key in `control.json`. `lib/homebridge-ui/`: the settings page (`server.js` uses `@homebridge/plugin-ui-utils`; `handlers.js` passes requests on and moves big files in pieces).
- `lib/web.js` + `lib/web-auth.js`: the optional web page on its own port (default 8591, `webPort: 0` = never). Only listens once a PIN is set. Home-network addresses and Host names only, custom header + Origin check, scrypt PIN, per-address and whole-page wrong-PIN limits, sign-ins end after 180 days. It can never change the PIN or the web settings (`web*` actions).

Files in Homebridge's storage folder, under `home-energy/`: `state.json`, `backups/`, `matter-controller/`, `control.json` + `control.sock`.

## Tests

- `lib/*.test.js`: unit tests next to the code (Warwick's original checks, moved to vitest, plus one test per review fix)
- `test/e2e.test.js`: the plugin inside Homebridge's own API and HAP (loaded by file path from the `homebridge` dev dependency, in `test/harness.js`) against a pretend Shelly EM (`test/fake-shelly.js`), with `test/matter-stand-in.js`, a stand-in Matter API that keeps Homebridge's rules
- `test/web.test.js` and `test/boot.test.js`: the real plugin on a stand-in Homebridge (`test/fake-homebridge.js`) with the stand-in Matter controller (`test/fake-matter-worker.js`)
- `test/config-schema.test.js`: keeps `config.schema.json` and `package.json` right for the Homebridge UI and Homebridge verification
- The browser test of the settings page is separate and run by hand: see `test/README.md`
