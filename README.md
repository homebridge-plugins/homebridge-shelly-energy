# Shelly Home Energy Monitoring (homebridge-shelly-home-energy-monitoring)

A Homebridge 2.x plugin that works out what's using power in your home, from a Shelly energy meter and the Shellys and Matter
devices on your network, and shows it in Apple Home. Nothing leaves your home network: there are no accounts and no cloud
services. The settings page is in the Homebridge UI, and optionally also on your home network behind a PIN (see Web page).
## What it does

- **Learns appliances from your whole-house meter.** It reads a Shelly EM every second, spots power steps and learns
  appliances from steps that repeat. It then counts runs and kWh per appliance per day and per hour. Whatever the
  named appliances don't explain is counted as "Other".
- **Uses exact figures where it can get them.** Any Shelly or Matter device that measures its own watts can be tracked as
  an appliance. For those, it learns how long each programme pauses (so a wash with a long soak isn't split in two), the
  level it rests at, and any standby above 5 W.
- **Works with Wi-Fi Shellys of every generation:**
  - **as the whole-house meter:** EM Gen3/Gen4, EM Mini Gen4, Pro EM, Pro 3EM, 3EM-63 Gen3, and the Gen1 EM and 3EM;
  - **as devices to track:** plugs, relays with metering (1PM, 2PM, Pro 1/2/4PM, Power Strip), PM Mini meters, dimmers and
    LED controllers with metering, shutter controllers, the clamps of an EM, and Gen1 1PM, 2.5, Plug S and Dimmer, on
    Shelly's own firmware or the HomeKit firmware.
  Shelly Wave (Z-Wave) and Gen4 devices in Zigbee-only mode can't be reached over Wi-Fi.
- **Finds your Shellys for you.** Settings → Shellys and Matter devices → **Find Shellys on this network** asks every
  address on the Homebridge computer's home network (about 10 seconds, only when you press it) and lists each Shelly with
  what it measures, ready to add. Where a Shelly's `.local` name works, that's what gets saved, so it keeps working when
  your router gives it a new address. Shellys on a separate network for smart devices aren't reachable this way; add those
  by address.
- **Learns each appliance's cycles.** For an appliance measured by its own plug (a dishwasher, a washing machine), each
  full run's power pattern is kept, and runs that look alike become one cycle (Eco, Quick, Cotton…; you name them in its Edit
  panel). While it runs, the plugin works out which cycle it's in from the pattern so far and shows the time left on the
  page and on a **Faucet** running tile in Apple Home. A run in one of its own cycles is never flagged as unusual.
- **Learns watts for switches that don't measure.** For an on/off device such as a Shelly 1 relay, it learns the watts
  from the whole-house meter each time the device switches.
- **Apple Home tiles:**
  - one Matter outlet per appliance with live watts and energy, plus "Other";
  - optional HomeKit tiles that show when an appliance is running, as a faucet, switch, outlet, light, fan, air purifier,
    humidifier, dehumidifier, heater, air conditioner, occupancy, contact or motion sensor. They only show; tapping one in
    the Home app doesn't switch anything. Humidifier, heater and air conditioner tiles must show a humidity or temperature:
    a sensor the plugin reads (a Matter hub's, say), otherwise 50% / 20°C;
  - a "Cheap Power Now" tile, if you have a time-of-use plan.
- **Spots problems:** standby use, the always-on load, and runs that are far longer or shorter than that appliance's
  usual.
- **Ways to save:** tips worked out from your own readings, each with its saving per week, month and year. They cover
  moving appliances to cheaper hours, standby, an always-on load that went up, appliances using more than the month
  before, runs getting longer (with a likely cause), and the cost of each run. There are no generic tips.

Everything is set up on the plugin's own page in the Homebridge UI (Plugins → Shelly Home Energy Monitoring → Settings): **Today** (what's running, energy and cost, ways to save, a to-do list), **Appliances** (everything that uses power, by room, with anything found but not set up yet at the top) and **Settings** (the meter, your Shellys and Matter devices, the electricity plan, Apple Home, the web page and data).

## Web page

The same page is also at `http://<your Homebridge computer>:8591/`, for phones and computers on your home network.
- **Off until a PIN is set.** Set the PIN in the Homebridge UI, under Settings → Web page; that's also where you switch the page
  off or sign every browser out. Each browser asks for the PIN once.
- **Home network only.** Addresses outside your home network are refused, and five wrong PINs make that device wait 10 minutes.
- **No PIN or config.json controls on it.** It can't change its own PIN or settings, or edit config.json.
- **A different port** goes in `"webPort"` in the plugin's config; `0` turns the web page off completely.

## Needs

- Homebridge 2.4 or newer, with Node 22.18 or newer.
- A child bridge for this plugin with **Matter** on, plus **HomeKit** on if you want running tiles or Cheap Power Now.
- Live watts on Apple Home tiles need iOS / tvOS 27 or later.
- Shellys with a password set can't be read.

## Install or update

In the Homebridge UI: **Plugins**, search for **homebridge-shelly-home-energy-monitoring**, Install. Or in a terminal:
`sudo npm install -g homebridge-shelly-home-energy-monitoring`.

From the source folder instead (macOS paths shown):

```
cd ~/Documents/homebridge-shelly-home-energy-monitoring && npm pack
sudo npm install -g ./homebridge-shelly-home-energy-monitoring-1.1.1.tgz
```

Then restart Homebridge, give the plugin a child bridge with Matter on (Plugins → ⋮ → Bridge Settings), restart again, and
open the plugin's settings page. The install downloads matter.js and the Homebridge UI helper, so it needs internet access
for that step only.

## Privacy and security

- **Nothing leaves your home network.** No accounts, no cloud services, no analytics. The plugin talks only to the Shelly and
  Matter devices you add, on addresses on your home network (anything else is refused), and Find Shellys only asks addresses
  on the Homebridge computer's own home network, only when you press it.
- **Read-only.** It never switches a Shelly or Matter device. Apple Home tiles only show; tapping one changes nothing.
- **Matter devices** are joined as a second controller (multi-admin) with a code from the Home app; they stay in Apple Home.
- **The settings page** talks to the plugin over a local socket file only the Homebridge user can open, with a random key.
- **The optional web page** (port 8591, off until a PIN is set): home-network addresses and host names only; the PIN is stored
  as a scrypt hash; signed-in browsers hold a random key in an HttpOnly, SameSite=Strict cookie; five wrong PINs lock that
  device out for 10 minutes; it can't change its own PIN or settings. It's plain HTTP, so use it only on a network you trust.
- **Saved data and backups** are readable only by the Homebridge user and never include the web page's PIN.
- Shellys with a password set can't be read: the plugin doesn't store device passwords.

## Where things are kept

- `~/.homebridge/home-energy/state.json`: appliances, history, settings. Readings are saved every 5 minutes, changes
  within 30 seconds.
- `~/.homebridge/home-energy/backups/`: backups made with Settings → Data → Download a backup (the newest 10). They're
  listed under Import from backup. In the Homebridge UI the browser may not download the file itself (the UI doesn't let
  plugin pages download); on the web page it does.
- `~/.homebridge/home-energy/matter-controller/`: this plugin's Matter controller.
- `control.sock` / `control.json`: the link between the plugin and its settings page: a local socket file, not a network port.

## Tests (development only, not in the package)

`node test/run-all.mjs` runs the unit tests and a start-up test against stand-ins. `test/README.md` explains the
browser test of the settings page.

## Licence

MIT, see LICENSE. The matter.js controller calls in `lib/matter-controller.js` follow, and the run learning of measured
appliances is based on the ideas of, [homebridge-appliance-monitor](https://github.com/rummeyer/homebridge-appliance-monitor)
(MIT); the code here is this plugin's own.
