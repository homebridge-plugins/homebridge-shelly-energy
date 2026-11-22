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
