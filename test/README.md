# Tests (development only: package.json's `files` leaves this folder out)

No Homebridge, Shelly or Matter hardware needed: everything runs against stand-ins on this computer.

- `node test/run-all.mjs`: all of the below except the browser test.
- `engine-unit.mjs`: step detection, naming, stages, runs, anomalies, measured and estimated appliances, Other, costs, suggestions, saving, memory caps.
- `shelly-unit.mjs`: home-network addresses, the Shelly EM poller, HomeKit-firmware and Gen2+ readers, offline and back.
- `matter-unit.mjs`: Matter devices through `fake-matter-worker.mjs` and the real `lib/matter-hub.js` (GRILLPLATS mirror rule, pairing, reconnecting after a restart, controller restarts).
- `tiles-unit.mjs`: Matter outlets and HAP tiles against `fake-homebridge.mjs` (identities, copies, Cheap Power Now, never removing tiles this plugin didn't publish).
- `discover-unit.mjs`: Find Shellys: which addresses are asked (home network only), each kind of Shelly found, .local names.
- `cycles-unit.mjs`: learning an appliance's cycles from runs that vary like real ones, and matching a run part-way through.
- `import-unit.mjs`: backups: saving, listing and restoring. `fixtures/backup.json` is a made-up backup in this plugin's own format.
- `insights-unit.mjs`: Ways to save on made-up history (each tip, no plan, dismissing).
- `web-unit.mjs`: the web page on port 18591 with the real plugin: host names, header and origin checks, PIN, lock-out, nothing secret sent, the web page can't change its own PIN.
- `ui-unit.mjs`: the settings page's server side (allowed actions, files in pieces, plugin not running).
- `boot.mjs [seconds]`: starts the real `index.js` on a stand-in Homebridge and drives it through the settings-page link. Run it whenever start-up changes.

Browser test of the settings page, shown inside a sandboxed frame like the Homebridge UI (needs Python Playwright and Chrome at /usr/bin/google-chrome; takes about 2 minutes, because it waits
for a repeating step to appear):

```
node test/ui-serve.mjs 8599 &          # the real plugin + page on stand-ins, at http://127.0.0.1:8599/
python3 -I -u test/ui-test.py 8599 /tmp/shots
```

Stand-ins: `fake-shelly.mjs` (HomeKit firmware Shelly 1, Gen2 plug, Shelly EM Gen4), `fake-matter-worker.mjs` (set with
`HE_MATTER_WORKER`), `fake-homebridge.mjs` (HAP + api.matter).
