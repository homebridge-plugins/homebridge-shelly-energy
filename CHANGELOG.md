# Change Log

All notable changes to `@homebridge-plugins/homebridge-shelly-energy` will be documented in this file.

## v1.1.0 (2026-11-22)

### Changed

- feat: bring in the original author's 1.7.6 with gap filling, safer saves, rooms and recordings
- fix(ui): escape a device's id in the room picker
- fix: refuse hex and whole-number addresses that fetch reads as internet addresses
- fix: don't fill a gap of more than 31 days, so a clock jump keeps the real days
- fix: keep merged steps on the chosen appliance when another room has one of the same name
- fix: keep the day's figures numbers when a run began with a shared step
- fix: move a merged appliance's shared steps across too, so its runs still end
- fix: let an appliance a device used to measure be merged into another
- fix: don't end a variable load's run with the cap meant for on/off appliances
- fix: stop a failed recording's timer, so it can't cut the next recording short
- fix: compare the settings page's key as bytes, so an odd key can't crash homebridge
- fix: carry on reading when the clock is put back right after running ahead
- fix: write the save file by its path, so the plugin checks don't see a write outside storage

## v1.0.0 (2026-11-22)

### Changed

- chore: import the shelly home energy plugin source
- refactor: move the code into lib, and use the org package name, workflows and issue forms
- chore: name homebridge-plugins as the copyright holder in the licence
- chore: apply the org lint rules
- test: run the tests with vitest, and the plugin inside homebridge against a pretend meter
- fix(schema): list the name as required the json schema way
- fix: add the supports-hap and supports-matter keywords
- fix: stop reading test settings from environment variables
- fix: refuse addresses with a leading zero, which fetch reads as another address
- fix(web): limit wrong pins for the whole page, and ask for 6 or more characters
- fix: limit the size and number of backup uploads
- fix(matter): keep the matter controller's keys readable by the homebridge user only
- fix(web): only open the web page's port once a pin is set
- fix(web): end web page sign-ins after 180 days, as their cookie does
- fix: keep the settings page's socket in a private folder when the storage path is long
- fix: only run the plugin's own action names
- fix: keep a gen1 em or 3em clamp chosen on the settings page
- fix: end a learned appliance's run that goes on far longer than its usual ones
- fix: count past days by calendar day, so the spring clock change skips none
- fix: forget a saved reading time that is in the future
- fix: rename homekit tiles with updateDisplayName
- fix: remove cached tiles and outlets the plugin no longer has
- fix: stop asking for a child bridge when matter is on for the main bridge
- perf: save power steps with the readings every 5 minutes, not within 30 seconds
- fix: refuse backup appliance ids that javascript treats as special
- docs: use the org readme, and add claude and copilot instructions
- docs: add the shelly banner and plugin icon
- docs(schema): explain the meter reading and web page port settings
- chore(deps): dependency updates
