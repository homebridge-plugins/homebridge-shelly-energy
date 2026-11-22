# Tests (development only: `.npmignore` leaves this folder and every `*.test.js` out of the package)

No Homebridge, Shelly or Matter hardware needed: everything runs against stand-ins on this computer.

- `npm test`: every test below except the browser test (vitest, about 10 seconds).
- Unit tests, next to the code in `lib/`:
  - `engine.test.js`: step detection, naming, stages, runs, anomalies, measured and estimated appliances, Other, costs,
    suggestions, saving, memory caps.
  - `shelly-devices.test.js`: home-network addresses, the Shelly EM poller, the HomeKit-firmware, Gen1 and Gen2+ readers,
    offline and back.
  - `matter-devices.test.js`: Matter devices through `test/fake-matter-worker.js` and the real `lib/matter-hub.js`
    (GRILLPLATS mirror rule, pairing, reconnecting after a restart, controller restarts).
  - `tiles.test.js`: Matter outlets and HAP tiles against `test/fake-homebridge.js` (identities, copies, Cheap Power Now).
  - `discover.test.js`: Find Shellys: which addresses are asked (home network only), each kind of Shelly found, .local names.
  - `cycles.test.js`: learning an appliance's cycles from runs that vary like real ones, and matching a run part-way through.
  - `import.test.js`: backups: saving, listing and restoring. `test/fixtures/backup.json` is a made-up backup in this
    plugin's own format.
  - `insights.test.js`: Ways to save on made-up history (each tip, no plan, dismissing).
  - `homebridge-ui/handlers.test.js`: the settings page's server side (allowed actions, files in pieces, plugin not running).
- Tests of the whole plugin, in `test/`:
  - `e2e.test.js`: the plugin inside Homebridge's own API and HAP (`harness.js`, loaded by file path from the `homebridge`
    dev dependency), with a stand-in Matter API that keeps Homebridge's rules (`matter-stand-in.js`), against a pretend
    Shelly EM.
  - `web.test.js`: the web page on port 18591 with the real plugin: host names, header and origin checks, PIN, lock-out,
    nothing secret sent, the web page can't change its own PIN.
  - `boot.test.js`: starts the real plugin on a stand-in Homebridge and drives it through the settings-page link.

Browser test of the settings page, shown inside a sandboxed frame like the Homebridge UI (needs Python Playwright and Chrome
at /usr/bin/google-chrome; takes about 2 minutes, because it waits for a repeating step to appear):

```
node test/ui-serve.js 8599 &          # the real plugin + page on stand-ins, at http://127.0.0.1:8599/
python3 -I -u test/ui-test.py 8599 /tmp/shots
```

Stand-ins: `fake-shelly.js` (HomeKit firmware Shelly 1, Gen1 and Gen2 Shellys, Shelly EM Gen4), `fake-matter-worker.js`
(the Matter controller helper), `fake-homebridge.js` (HAP + api.matter, for the unit tests).
