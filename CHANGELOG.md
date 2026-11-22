# Change Log

All notable changes to `@homebridge-plugins/homebridge-shelly-energy` will be documented in this file.

## v1.0.0 (Pending Release)

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
